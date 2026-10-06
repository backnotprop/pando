// Builds of main, tags and releases, end to end against `wrangler dev` with real Artifacts
// (research/plans/releases-2026-10-04):
//   1. a merge builds main's merge commit: the Buildkite hook on `merged` sends the merge commit on main, with a
//      status token for that commit;
//   2. the project's summary: main's commit reads "not built" with no statuses (the merge gate still merges), its
//      checks once a status lands, and the newest build on main from Buildkite's webhook;
//   3. tags: recorded by the door (an annotated tag peeled), listed, tag.created and tag.deleted on the stream, the
//      `tag` hook event; moved and deleted freely while no release holds them;
//   4. releases: made from main only, notes written from the merges since the last release (the issues they
//      closed), published only on green required checks unless forced, the tag made at publish and then frozen
//      (git can't move or delete it), freed when the release is deleted.
//
//   PANDO_URL=http://localhost:8867 node test/releases.mjs
//
// Reads PANDO_BOOTSTRAP and PANDO_STATUS_SECRET from worker/.dev.vars. Buildkite is a local stand-in. Git runs with
// a temp HOME, no system config and an empty credential helper list before its own. Credentials and tokens are
// never printed. Every repository it makes is deleted at the end, pass or fail.
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeError, isConnectionReset, retryResetFetch, throwaways } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8867").replace(/\/$/, "");

const WS_ = URL_.replace(/^http/, "ws");

const VARS = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");

const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(VARS)?.[1];

const RECORDED = new URL("../../packages/contract/recorded/", import.meta.url);

const scrub = (s) =>
  String(s)
    .replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<artifacts-token>")
    .replace(/pst1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<status-token>")
    .replace(/pando_[a-f0-9]{20,}/g, "<credential>");

/** A real answer, for the contract's check (packages/contract/scripts/check-recorded.ts). */
const record = (file, schema, route, status, body) => writeFileSync(new URL(file, RECORDED), `${scrub(JSON.stringify({ schema, route, status, body }, null, 2))}\n`);

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`));
};

/**
 * One API call. wrangler dev closes idle keep-alive connections, and a request sent on one never reached it
 * (record.mjs makes the same call), so a reset is sent again once, whatever the method.
 */
const call = (method, path, secret, body, headers = {}) =>
  request(URL_, method, path, { secret, body, headers, redirect: "manual" }).catch((err) => {
    if (!isConnectionReset(err)) throw err;

    return request(URL_, method, path, { secret, body, headers, redirect: "manual" });
  });

const waitFor = async (pred, ms = 20_000) => {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await pred();

    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }

  return null;
};

/** An event socket that collects frames. */
function socket(path, secret) {
  const frames = [];
  const ws = new WebSocket(`${WS_}${path}`, { headers: { authorization: `Bearer ${secret}` } });

  ws.onmessage = (m) => {
    try {
      frames.push(JSON.parse(m.data));
    } catch {}
  };

  return { ws, frames, events: () => frames.filter((f) => f.type === "event") };
}

const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

// ── the receivers: Buildkite's create-build, Buildkite's REST API (for the CI connection) and a web hook ──
const got = { buildkite: [], web: [] };

const server = createServer((req, res) => {
  let raw = "";

  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    let body = null;

    try {
      body = JSON.parse(raw);
    } catch {}

    if (req.url === "/buildkite") got.buildkite.push(body);
    else if (req.url === "/web") got.web.push({ event: req.headers["x-pando-event"], body });

    res.writeHead(201, { "content-type": "application/json" }).end("{}");
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));

const port = server.address().port;

const id = Date.now().toString(36);

const work = mkdtempSync(join(tmpdir(), "pando-releases-"));

const home = join(work, "home");

mkdirSync(home);

const M = `rel-${id}`;

const E = `rel-empty-${id}`;

let O = null;

let S = null;

// This run's repositories: deleted at the end, pass or fail, and on Ctrl-C or kill.
const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, S)).status);

const env = {
  ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Rel", GIT_AUTHOR_EMAIL: "rel@pando.invalid", GIT_COMMITTER_NAME: "Rel", GIT_COMMITTER_EMAIL: "rel@pando.invalid",
};

// The keychain rule (AGENTS.md): no system config, the helper list emptied, then this one helper.
const git = (args, cwd) =>
  spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args], {
    cwd, env: { ...env, PANDO_SECRET: S }, encoding: "utf8",
  });

const sha = (cwd, rev = "HEAD") => git(["rev-parse", rev], cwd).stdout.trim();

/** A commit on a new branch, pushed, then merged by the API; answers the merge. */
async function landBranch(src, url, base, name, title, extra = {}) {
  git(["checkout", "-q", "main"], src);
  git(["pull", "-q", url, "main"], src);
  git(["checkout", "-qb", name], src);
  writeFileSync(join(src, `${name}.txt`), `${name}\n`);
  git(["add", "-A"], src);
  git(["commit", "-qm", `${name}: a change`], src);
  git(["push", "-q", url, name], src);
  await call("PATCH", `${base}/branches/${name}`, S, { title, ...extra });

  return (await call("POST", `${base}/branches/${name}/merge`, S, {})).json;
}

try {
  S = (await call("POST", "/v1/users", BOOT, { login: `rel-${id}` })).json?.credential?.secret;
  let r = await call("POST", "/v1/monorepos", S, { name: M, kind: "repo" });
  O = r.json?.monorepo?.owner ?? null;
  const MID = r.json?.monorepo?.id;
  let made = 0;

  if (r.status === 201) {
    tw.add(`${O}/${M}`);
    made++;
  }

  const url = r.json?.repos?.[0]?.clone_url;
  const base = `/v1/monorepos/${O}/${M}/repos/${M}`;
  r = await call("POST", "/v1/monorepos", S, { name: E, kind: "repo" });

  if (r.status === 201) {
    tw.add(`${O}/${E}`);
    made++;
  }

  check("two plain repositories made", made === 2 && !!url);

  // ── 1. A merge builds main's merge commit ──
  r = await call("POST", `${base}/hooks`, S, { type: "buildkite", events: ["push", "merged"], buildkite: { organization: "o", pipeline: "p", api_url: `http://127.0.0.1:${port}/buildkite` } });
  check("a Buildkite hook on push and merged", r.status === 201 && r.json?.events?.join() === "push,merged");
  r = await call("POST", `${base}/hooks`, S, { type: "web", url: `http://127.0.0.1:${port}/web`, secret: "s", events: ["tag"] });
  check("a web hook on the new `tag` event", r.status === 201 && r.json?.events?.join() === "tag");
  record("hook-tag.json", "Hook", "POST .../repos/{repo}/hooks {events: [tag]}", r.status, r.json);

  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# rel\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  check("main pushed", git(["push", "-q", url, "main"], src).status === 0);
  const main1 = sha(src);

  // The summary of an empty repository and of a main nothing reported on: "not built", never green.
  r = await call("GET", `/v1/monorepos/${O}/${E}/repos/${E}/summary`, S);
  check("an empty repository's summary: no commit, not built", r.status === 200 && r.json?.main?.sha === null && r.json.main.state === "not_built" && r.json.main.checks === null && r.json.latest_release === null);
  record("repo-summary-empty.json", "RepoSummary", "GET .../repos/{repo}/summary (empty)", r.status, r.json);

  r = await call("GET", `${base}/summary`, S);
  check("main with no statuses and no required checks reads not built", r.status === 200 && r.json?.main?.sha === main1 && r.json.main.state === "not_built" && r.json.main.checks?.state === "success" && r.json.main.build === null, r.json?.main?.state);
  record("repo-summary-not-built.json", "RepoSummary", "GET .../repos/{repo}/summary (nothing reported)", r.status, r.json);

  const merged = await landBranch(src, url, base, "feat-a", "Add feature A");
  check("feat-a merges with no checks at all (the merge gate is unchanged)", merged?.status === "merged" && merged.forced === false, JSON.stringify(merged)?.slice(0, 120));
  const mergeA = merged?.sha;
  const bkMerge = await waitFor(() => got.buildkite.find((b) => b.commit === mergeA));
  check("the merged hook builds main's merge commit, on main", !!bkMerge && bkMerge.branch === "main" && bkMerge.env?.PANDO_HEAD === mergeA && bkMerge.env.PANDO_BRANCH === "main" && bkMerge.env.PANDO_STATUS_URL.endsWith(`/statuses/${mergeA}`));
  check("no build of the branch head for the merge", !got.buildkite.some((b) => b.branch === "feat-a" && (b.message ?? "").startsWith("Merge")));
  const token = bkMerge?.env?.PANDO_STATUS_TOKEN;
  check("its status token is for the merge commit", !!token && claimsOf(token).s === mergeA && claimsOf(token).m === MID && claimsOf(token).a === "buildkite");

  r = await call("GET", `${base}/summary`, S);
  check("after the merge, main's summary is the merge commit, not built yet", r.json?.main?.sha === mergeA && r.json.main.state === "not_built" && r.json.main.title?.length > 0);

  r = await call("POST", `${base}/statuses/${mergeA}`, token, { state: "pending", context: "ci" });
  check("the build posts its check on the merge commit with that token", r.status === 201 && r.json?.app === "buildkite");
  r = await call("GET", `${base}/summary`, S);
  check("main's summary follows its checks: pending", r.json?.main?.state === "pending" && r.json.main.checks?.statuses?.length === 1);

  // The newest build on main, from Buildkite's webhook (a CI connection, as the CI tab makes it).
  r = await call("POST", `/v1/monorepos/${O}/${M}/ci/connections`, S, { service: "buildkite", organization: "o", api_url: `http://127.0.0.1:${port}` });
  const conn = r.json?.connection;
  const WH = r.json?.webhook_token;
  check("a Buildkite connection", r.status === 201 && !!WH);

  const sendHook = (event, payload) => {
    const body = JSON.stringify({ event, ...payload });
    const ts = Math.floor(Date.now() / 1000);

    return request(URL_, "POST", `/v1/integrations/buildkite/${conn.id}`, {
      raw: body, headers: { "x-buildkite-event": event, "x-buildkite-signature": `timestamp=${ts},signature=${createHmac("sha256", WH).update(`${ts}.${body}`).digest("hex")}` },
    });
  };

  const pipeline = { id: "pl-p", slug: "p", name: "p", web_url: "https://buildkite.com/o/p", url: "https://api.buildkite.com/v2/organizations/o/pipelines/p", repository: "x", default_branch: "main" };
  const at = (ms) => new Date(Date.now() - 60_000 + ms).toISOString();

  const build = (state, o = {}) => ({
    id: "bld-main-142", number: 142, state, blocked: false, message: bkMerge?.message ?? "merge", commit: mergeA, branch: "main", source: "api", creator: null,
    web_url: "https://buildkite.com/o/p/builds/142", url: "https://api.buildkite.com/v2/organizations/o/pipelines/p/builds/142", meta_data: bkMerge?.meta_data ?? {},
    created_at: at(0), scheduled_at: at(0), started_at: at(1000), finished_at: null, ...o,
  });

  r = await sendHook("build.finished", { build: build("passed", { finished_at: at(50_000) }), pipeline });
  check("Buildkite's webhook records main's build", r.status === 200, r.text.slice(0, 120));
  await call("POST", `${base}/statuses/${mergeA}`, token, { state: "success", context: "ci" });
  r = await call("GET", `${base}/summary`, S);
  check("main's summary: success, and the newest build on main (#142, passed)", r.json?.main?.state === "success" && r.json.main.build?.number === 142 && r.json.main.build.state === "passed" && r.json.main.build.branch === "main" && r.json.main.build.sha === mergeA);
  record("repo-summary.json", "RepoSummary", "GET .../repos/{repo}/summary", r.status, r.json);

  // ── 3. Tags ──
  const sock = socket(`/v1/monorepos/${O}/${M}/events?topics=kind:tag.created,kind:tag.deleted,kind:release.created,kind:release.updated,kind:release.published,kind:release.deleted`, S);
  await waitFor(() => sock.frames.some((f) => f.type === "caught_up"), 10_000);
  git(["checkout", "-q", "main"], src);
  git(["pull", "-q", url, "main"], src);
  git(["tag", "v0.0.1"], src);
  git(["tag", "-a", "v0.0.2", "-m", "annotated"], src);
  const tagObject = sha(src, "v0.0.2");
  r = { status: git(["push", "-q", url, "v0.0.1", "v0.0.2"], src).status };
  check("two tags pushed (lightweight and annotated)", r.status === 0);
  r = await call("GET", `${base}/tags`, S);
  const t1 = r.json?.tags?.find((t) => t.name === "v0.0.1");
  const t2 = r.json?.tags?.find((t) => t.name === "v0.0.2");
  check("the door recorded both; the annotated one peeled to its commit", r.status === 200 && t1?.sha === mergeA && !t1.annotated && t2?.sha === mergeA && t2.annotated && tagObject !== mergeA && t1.created_by === `rel-${id}` && !t1.frozen);
  record("tags.json", "TagList", "GET .../repos/{repo}/tags", r.status, r.json);
  const tagHook = await waitFor(() => got.web.filter((w) => w.event === "tag").length >= 2 && got.web);
  check("the `tag` hook event, with the tag and its commit", !!tagHook && got.web.some((w) => w.body?.tag === "v0.0.2" && w.body.head === mergeA && w.body.ref === "refs/tags/v0.0.2"));
  check("tag.created on the stream", !!(await waitFor(() => sock.events().filter((e) => e.kind === "tag.created").length >= 2)));

  r = { status: git(["push", "-q", url, ":refs/tags/v0.0.2"], src).status };
  check("a tag no release holds is deleted freely", r.status === 0);
  r = await call("GET", `${base}/tags`, S);
  check("gone from the list, with tag.deleted and a `tag` hook event with zeros", !r.json?.tags?.some((t) => t.name === "v0.0.2") &&
    !!(await waitFor(() => sock.events().some((e) => e.kind === "tag.deleted" && e.row?.name === "v0.0.2"))) &&
    !!(await waitFor(() => got.web.some((w) => w.body?.tag === "v0.0.2" && /^0{40}$/.test(w.body.head)))));
  record("tag-event-frames.json", "MonorepoEventFrame[]", "GET .../events?topics=kind:tag.created,kind:tag.deleted (WebSocket)", 101, sock.events().filter((e) => e.kind.startsWith("tag.")));
  git(["tag", "-f", "v0.0.1", main1], src);
  r = { status: git(["push", "-qf", url, "v0.0.1"], src).status };
  r = await call("GET", `${base}/tags`, S);
  check("a tag no release holds moves freely", r.json?.tags?.find((t) => t.name === "v0.0.1")?.sha === main1);

  // ── 4. Releases ──
  // A second member: anyone who may merge may publish.
  const bo = `rel-b-${id}`;
  const B = (await call("POST", "/v1/users", BOOT, { login: bo })).json?.credential?.secret;
  r = await call("PUT", `/v1/monorepos/${O}/${M}/members/${bo}`, S, { role: "member" });
  check("a second person, a member (not an owner)", r.status === 200 && !!B);
  const issue = async (title) => (await call("POST", `/v1/monorepos/${O}/${M}/issues`, S, { title })).json?.number;
  const i1 = await issue("The gate is slow");
  const i2 = await issue("Docs miss a page");
  const mb = await landBranch(src, url, base, "feat-b", "Speed up the gate", { description: `Fixes #${i1}` });
  const mc = await landBranch(src, url, base, "feat-c", "Add the missing page", { description: `Closes #${i2}` });
  const mainC = mc?.sha;
  check("two more branches merged, each closing an issue", mb?.status === "merged" && mc?.status === "merged" && mb.closes?.includes(i1) && mc.closes?.includes(i2));
  await waitFor(async () => (await call("GET", `/v1/monorepos/${O}/${M}/issues/${i2}`, S)).json?.state === "closed");

  const rel = (tag) => `${base}/releases/${encodeURIComponent(tag)}`;
  r = await call("POST", `${base}/releases`, S, { tag: "latest" });
  check("the tag latest is refused (it names the newest release in addresses)", r.status === 400);
  git(["checkout", "-q", "-b", "side", mainC], src);
  writeFileSync(join(src, "side.txt"), "side\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "not on main"], src);
  git(["push", "-q", url, "side"], src);
  r = await call("POST", `${base}/releases`, S, { tag: "v9.9.9", target: sha(src), draft: true });
  check("a release from a commit not on main is refused", r.status === 422 && r.json?.error?.code === "not_on_main", r.text.slice(0, 160));
  r = await call("POST", `${base}/releases`, S, { tag: "v0.0.1", target: mainC, draft: true });
  check("a release whose tag names another commit is refused", r.status === 409 && r.json?.error?.code === "tag_exists");

  r = await call("GET", `${rel("v0.1.0")}/notes?generate=1`, S);
  const notes = r.json?.markdown ?? "";
  check("notes generated from the merges: newest first, title, branch, who, issues closed", r.status === 200 && r.json.generated && r.json.merges === 3 && r.json.more === 0 && r.json.since === null && r.json.sha === mainC &&
    notes.startsWith("## Changes\n") && notes.indexOf("Add the missing page (`feat-c`)") < notes.indexOf("Speed up the gate (`feat-b`)") && notes.includes(`by rel-${id}, closes #${i1}`) && notes.includes(`closes #${i2}`) && notes.includes("Add feature A (`feat-a`)"), notes.slice(0, 300));
  record("release-notes-generated.json", "ReleaseNotes", "GET .../releases/{tag}/notes?generate=1", r.status, r.json);

  r = await call("POST", `${base}/releases`, S, { tag: "v0.1.0", title: "First release", generate_notes: true, draft: true });
  check("a draft release at main, its notes generated", r.status === 201 && r.json?.draft === true && r.json.sha === mainC && r.json.notes.includes("Speed up the gate") && r.json.published_at === null);
  record("release-draft.json", "Release", "POST .../releases {tag, title, generate_notes, draft}", r.status, r.json);
  check("a draft makes no tag yet", !(await call("GET", `${base}/tags`, S)).json?.tags?.some((t) => t.name === "v0.1.0"));

  await call("POST", `${base}/statuses/${mainC}`, S, { state: "failure", context: "ci" });
  r = await call("POST", `${rel("v0.1.0")}/publish`, B, {});
  check("publish is refused on red checks, the merge rule", r.status === 412 && r.json?.error?.code === "checks_not_green" && r.json.error.checks?.state === "failure");
  record("error-412-release-checks.json", "ErrorBody", "POST .../releases/{tag}/publish (red checks)", r.status, r.json);
  await call("POST", `${base}/statuses/${mainC}`, S, { state: "success", context: "ci" });
  r = await call("POST", `${rel("v0.1.0")}/publish`, B, {});
  check("a member publishes once green", r.status === 200 && r.json?.draft === false && r.json.forced === false && r.json.published_by === bo, r.text.slice(0, 160));
  const ls = git(["ls-remote", url, "refs/tags/v0.1.0"], src).stdout.trim().split("\t")[0];
  r = await call("GET", `${base}/tags`, S);
  check("publishing made the tag at the release's commit, recorded and frozen", ls === mainC && r.json?.tags?.find((t) => t.name === "v0.1.0")?.frozen === true && r.json.tags.find((t) => t.name === "v0.1.0").sha === mainC);

  let push = git(["push", url, ":refs/tags/v0.1.0"], src);
  check("git can't delete a published release's tag, with a plain message", push.status !== 0 && push.stderr.includes("belongs to the published release v0.1.0"), scrub(push.stderr).split("\n").find((l) => l.includes("v0.1.0")));
  git(["tag", "-f", "v0.1.0", main1], src);
  push = git(["push", "-f", url, "v0.1.0"], src);
  check("nor move it", push.status !== 0 && git(["ls-remote", url, "refs/tags/v0.1.0"], src).stdout.startsWith(mainC));

  r = await call("PATCH", rel("v0.1.0"), S, { title: "The first release" });
  check("its title edited", r.status === 200 && r.json?.title === "The first release");
  r = await call("GET", `${base}/releases/latest`, S);
  check("latest is the newest published release, with its commit's checks", r.status === 200 && r.json?.tag === "v0.1.0" && r.json.checks?.state === "success");
  record("release.json", "Release", "GET .../releases/latest", r.status, r.json);
  r = await call("GET", `${base}/summary`, S);
  check("the summary names the latest release", r.json?.latest_release?.tag === "v0.1.0" && r.json.latest_release.published_by === bo);

  const md = await landBranch(src, url, base, "feat-d", "Add release notes");
  r = await call("POST", `${base}/releases`, B, { tag: "v0.2.0", generate_notes: true });
  check("the next release: published at once, notes only since v0.1.0", r.status === 201 && r.json?.draft === false && r.json.sha === md?.sha && r.json.notes.startsWith("## Changes since v0.1.0") && r.json.notes.includes("Add release notes") && !r.json.notes.includes("Speed up the gate"), r.text.slice(0, 200));

  // Required checks (pando.toml on main): a missing one refuses an unforced release, as it refuses a merge.
  git(["checkout", "-q", "main"], src);
  git(["pull", "-q", url, "main"], src);
  git(["checkout", "-qb", "config"], src);
  mkdirSync(join(src, ".pando"), { recursive: true });
  writeFileSync(join(src, ".pando/pando.toml"), '[repos."."]\nrequired_checks = ["ci"]\n');
  git(["add", "-A"], src);
  git(["commit", "-qm", "require ci"], src);
  git(["push", "-q", url, "config"], src);
  const mcfg = (await call("POST", `${base}/branches/config/merge`, S, { force: true })).json;
  r = await call("POST", `${base}/releases`, S, { tag: "v0.3.0" });
  check("a release with a required check missing is refused, and leaves no draft", r.status === 412 && r.json?.error?.checks?.state === "missing" && (await call("GET", rel("v0.3.0"), S)).status === 404);
  r = await call("POST", `${base}/releases`, S, { tag: "v0.3.0", force: true });
  check("forced, it is published and says so", r.status === 201 && r.json?.forced === true && r.json.sha === mcfg?.sha);

  r = await call("GET", `${base}/releases?limit=2`, S);
  const page2 = r.json?.next_cursor ? (await call("GET", `${base}/releases?limit=2&cursor=${encodeURIComponent(r.json.next_cursor)}`, S)).json : null;
  check("releases list newest first, paged", r.status === 200 && r.json.releases.map((x) => x.tag).join() === "v0.3.0,v0.2.0" && page2?.releases?.map((x) => x.tag).join() === "v0.1.0" && page2.next_cursor === null);
  record("releases.json", "ReleaseList", "GET .../releases?limit=2", r.status, r.json);

  r = await call("DELETE", rel("v0.1.0"), B);
  check("a member deletes a release", r.status === 204);
  r = await call("GET", `${base}/tags`, S);
  check("its tag stays, free again", r.json?.tags?.find((t) => t.name === "v0.1.0")?.frozen === false);
  push = git(["push", url, ":refs/tags/v0.1.0"], src);
  check("and git can delete it now", push.status === 0 && git(["ls-remote", url, "refs/tags/v0.1.0"], src).stdout.trim() === "");
  check("release events on the stream: created, updated, published, deleted", !!(await waitFor(() => ["release.created", "release.updated", "release.published", "release.deleted"].every((k) => sock.events().some((e) => e.kind === k)))));
  record("release-event-frames.json", "MonorepoEventFrame[]", "GET .../events?topics=kind:release.* (WebSocket)", 101, sock.events().filter((e) => e.kind.startsWith("release.")));

  // ── 5. pando release, the cli ──
  const bin = join(work, "pando");
  const built = spawnSync("go", ["build", "-buildvcs=false", "-o", bin, "./cmd/pando"], { cwd: fileURLToPath(new URL("../../cli", import.meta.url)), encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  check("the cli builds", built.status === 0, built.stderr?.slice(0, 200));
  const pandoEnv = { ...env, PANDO_HOME: join(work, "pando-home") };
  const pando = (args, input) => spawnSync(bin, args, { cwd: work, env: pandoEnv, encoding: "utf8", input });
  const said = (x) => scrub(`${x.stdout}${x.stderr}`).trim().slice(0, 300);
  let cmd = pando(["login", "--server", URL_, "--with-credential"], `${S}\n`);
  check("pando login --with-credential", cmd.status === 0, said(cmd));
  const mono = ["--monorepo", `${O}/${M}`];
  cmd = pando(["release", "list", ...mono]);
  check("pando release list: newest first, with their state", cmd.status === 0 && /TAG\s+TITLE\s+STATE\s+COMMIT\s+WHEN/.test(cmd.stdout) && cmd.stdout.indexOf("v0.3.0") < cmd.stdout.indexOf("v0.2.0") && /v0\.3\.0\s+v0\.3\.0\s+published \(forced\)/.test(cmd.stdout), said(cmd));
  cmd = pando(["release", "create", "v0.4.0", "--generate", ...mono]);
  check("pando release create refuses on a missing required check, and says how to go on", cmd.status !== 0 && cmd.stderr.includes("checks are missing") && cmd.stderr.includes("pando release publish v0.4.0 --force"), said(cmd));
  cmd = pando(["release", "create", "v0.4.0", "--generate", "--force", "--title", "Fourth", ...mono]);
  check("pando release create --force publishes and says so", cmd.status === 0 && cmd.stdout.includes("Published v0.4.0") && cmd.stdout.includes("forced"), said(cmd));
  cmd = pando(["release", "view", ...mono]);
  check("pando release view: the latest, with its notes", cmd.status === 0 && cmd.stdout.startsWith("v0.4.0  Fourth") && cmd.stdout.includes("No branches were merged since v0.3.0."), said(cmd));
  cmd = pando(["release", "view", "v0.4.0", "--json", ...mono]);
  check("pando release view --json: the API's answer", cmd.status === 0 && JSON.parse(cmd.stdout).tag === "v0.4.0" && JSON.parse(cmd.stdout).checks?.state === "missing");
  cmd = pando(["release", "create", "v0.5.0", "--draft", "--notes", "Draft notes", ...mono]);
  check("pando release create --draft", cmd.status === 0 && cmd.stdout.startsWith("Draft v0.5.0"), said(cmd));
  const head5 = JSON.parse(pando(["release", "view", "v0.5.0", "--json", ...mono]).stdout).sha;
  cmd = pando(["release", "publish", "v0.5.0", ...mono]);
  check("pando release publish refuses while the check is missing", cmd.status !== 0 && cmd.stderr.includes("--force"), said(cmd));
  await call("POST", `${base}/statuses/${head5}`, S, { state: "success", context: "ci" });
  cmd = pando(["release", "publish", "v0.5.0", ...mono]);
  check("and publishes once it is green", cmd.status === 0 && cmd.stdout.startsWith("Published v0.5.0 at") && !cmd.stdout.includes("forced"), said(cmd));
  cmd = pando(["release", "delete", "v0.5.0", ...mono]);
  check("pando release delete asks first (no terminal: needs --yes)", cmd.status !== 0 && cmd.stderr.includes("--yes"), said(cmd));
  cmd = pando(["release", "delete", "v0.5.0", "--yes", ...mono]);
  check("pando release delete --yes", cmd.status === 0 && cmd.stdout.includes("Deleted release v0.5.0") && (await call("GET", rel("v0.5.0"), S)).status === 404, said(cmd));

  // ── 6. Release files in R2, and the switch "Anyone can download releases" ──
  const files = (tag, name) => `${rel(tag)}/files/${name}`;

  const put = (path, secret, bytes, headers = {}) =>
    fetch(`${URL_}${path}`, { method: "PUT", headers: { authorization: `Bearer ${secret}`, "content-type": "text/plain", ...headers }, body: bytes }).then(async (x) => ({ status: x.status, json: await x.json().catch(() => null) }));

  const getFile = (path, secret) => fetch(`${URL_}${path}`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} }).then(async (x) => ({ status: x.status, text: await x.text(), headers: x.headers }));
  const hello = "hello from a release\n";
  const helloSum = createHash("sha256").update(hello).digest("hex");
  r = await put(files("v0.4.0", "hello.txt"), B, hello, { "x-pando-sha256": helloSum });
  check("a member uploads a file: its size and SHA-256 kept", r.status === 201 && r.json?.files?.length === 1 && r.json.files[0].sha256 === helloSum && r.json.files[0].size === hello.length && r.json.files[0].uploaded_by === bo && r.json.files[0].content_type === "text/plain");
  record("release-with-file.json", "Release", "PUT .../releases/{tag}/files/{name}", r.status, r.json);
  let dl = await getFile(files("v0.4.0", "hello.txt"), S);
  check("a member downloads it, with its SHA-256", dl.status === 200 && dl.text === hello && dl.headers.get("x-pando-sha256") === helloSum && dl.headers.get("content-disposition") === 'attachment; filename="hello.txt"');
  dl = await getFile(files("v0.4.0", "hello.txt"), null);
  check("without signing in: refused (members only by default)", dl.status === 401);
  r = await put(files("v0.4.0", "bad.txt"), S, hello, { "x-pando-sha256": "0".repeat(64) });
  check("a file whose SHA-256 is not the one sent is not kept", r.status === 422 && r.json?.error?.code === "sha256_mismatch" && (await getFile(files("v0.4.0", "bad.txt"), S)).status === 404);
  r = await put(files("v0.4.0", ".hidden"), S, hello);
  check("a file name must start with a letter or digit", r.status === 400);
  r = await fetch(`${URL_}${files("v0.4.0", "stream.txt")}`, { method: "PUT", headers: { authorization: `Bearer ${S}` }, body: new Blob([hello]).stream(), duplex: "half" }).then((x) => x.status);
  check("an upload without Content-Length is refused (411)", r === 411);
  // One byte over (wrangler dev reads a body before the Worker sees it, so it is sent whole; Cloudflare's edge refuses past 100 MB itself).
  r = await fetch(`${URL_}${files("v0.4.0", "huge.bin")}`, { method: "PUT", headers: { authorization: `Bearer ${S}` }, body: Buffer.alloc(100_000_001) }).then(async (x) => ({ status: x.status, text: await x.text() }));
  check("a file over 100 MB is refused", r.status === 413 && r.text.includes("100,000,000 bytes") && (await getFile(files("v0.4.0", "huge.bin"), S)).status === 404, r.text.slice(0, 160));

  // 20 files a release, then refused; a name sent again replaces its file.
  for (let n = 1; n <= 20; n++) await put(files("v0.2.0", `f${n}.txt`), S, `${n}\n`);
  r = await put(files("v0.2.0", "f21.txt"), S, "21\n");
  check("a release keeps at most 20 files", r.status === 409 && r.json?.error?.code === "too_many_files");
  r = await put(files("v0.2.0", "f1.txt"), S, "one again\n");
  check("uploading a name again replaces it", r.status === 200 && r.json?.files?.length === 20 && r.json.files.find((f) => f.name === "f1.txt")?.size === 10);
  r = await call("DELETE", files("v0.2.0", "f2.txt"), B);
  check("a member deletes a file", r.status === 204 && (await getFile(files("v0.2.0", "f2.txt"), S)).status === 404 && (await call("GET", rel("v0.2.0"), S)).json?.files?.length === 19);

  r = await call("PATCH", base, B, { releases_public: true });
  check("only an owner turns on \"Anyone can download releases\"", r.status === 403);
  r = await call("PATCH", base, S, { releases_public: true });
  check("an owner turns it on", r.status === 200 && r.json?.releases_public === true);
  r = await call("GET", base, S);
  check("the project says so", r.json?.releases_public === true);
  record("repo-releases-public.json", "Repo", "GET .../repos/{repo} (the switch on)", r.status, r.json);
  dl = await getFile(files("v0.4.0", "hello.txt"), null);
  check("now anyone downloads its release files, without signing in", dl.status === 200 && dl.text === hello && dl.headers.get("cache-control")?.startsWith("public"));
  dl = await getFile(`${base}/releases/latest/files/hello.txt`, null);
  check("latest works too (the newest published release)", dl.status === 200 && dl.text === hello);
  const N = (await call("POST", "/v1/users", BOOT, { login: `rel-n-${id}` })).json?.credential?.secret;
  dl = await getFile(files("v0.4.0", "hello.txt"), N);
  check("and a signed-in person who is not a member", dl.status === 200);
  check("but never the code or anything else: tree, releases, tags", (await getFile(`${base}/tree?ref=main`, null)).status === 401 && (await getFile(`${base}/releases`, null)).status === 401 && (await getFile(`${base}/tags`, N)).status === 403);
  check("a file that is not there is a 404", (await getFile(files("v0.4.0", "nope.txt"), null)).status === 404);
  await call("PATCH", base, S, { releases_public: false });
  check("turned off, downloads are members only again", (await getFile(files("v0.4.0", "hello.txt"), null)).status === 401 && (await getFile(files("v0.4.0", "hello.txt"), N)).status === 403);

  // The cli: a release made with its files, downloaded and checked.
  const dist = join(work, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "pando-linux-amd64"), "linux binary\n");
  writeFileSync(join(dist, "pando-darwin-arm64"), "mac binary\n");
  cmd = pando(["release", "create", "v0.6.0", join(dist, "pando-linux-amd64"), join(dist, "pando-darwin-arm64"), "--generate", "--force", ...mono]);
  check("pando release create <tag> <file>...: uploads, then publishes", cmd.status === 0 && cmd.stdout.includes("Uploaded pando-linux-amd64") && cmd.stdout.includes("Uploaded pando-darwin-arm64") && cmd.stdout.includes("Published v0.6.0"), said(cmd));
  r = await call("GET", rel("v0.6.0"), S);
  check("the release has both files, published", r.json?.draft === false && r.json.files.map((f) => f.name).join() === "pando-darwin-arm64,pando-linux-amd64");
  cmd = pando(["release", "download", "--dir", join(work, "got"), ...mono]);
  check("pando release download: the latest's files, checked by SHA-256", cmd.status === 0 && readFileSync(join(work, "got", "pando-linux-amd64"), "utf8") === "linux binary\n" && readFileSync(join(work, "got", "pando-darwin-arm64"), "utf8") === "mac binary\n", said(cmd));
  cmd = pando(["release", "download", "v0.6.0", "--pattern", "pando-darwin-*", "--dir", join(work, "mac"), ...mono]);
  check("--pattern picks files", cmd.status === 0 && cmd.stdout.split("\n").filter((l) => l.startsWith("Downloaded")).length === 1, said(cmd));
  writeFileSync(join(dist, "SHA256SUMS"), "sums\n");
  cmd = pando(["release", "upload", "v0.6.0", join(dist, "SHA256SUMS"), ...mono]);
  check("pando release upload adds a file", cmd.status === 0 && cmd.stdout.startsWith("Uploaded SHA256SUMS"), said(cmd));
  cmd = pando(["release", "view", "v0.6.0", ...mono]);
  check("pando release view lists its files", cmd.status === 0 && /file SHA256SUMS\s+5 bytes\s+sha256 [0-9a-f]{12}/.test(cmd.stdout), said(cmd));
  r = await call("DELETE", rel("v0.6.0"), S);
  check("deleting a release deletes its files", r.status === 204 && (await getFile(files("v0.6.0", "SHA256SUMS"), S)).status === 404);

  // ── 7. Deployments, recorded; and which commit the Worker runs ──
  const v2 = (await call("GET", rel("v0.2.0"), S)).json;
  r = await call("POST", `${base}/deployments`, B, { environment: "pando-dev", sha: v2?.sha, url: "https://pando-dev.example.invalid", description: "deploy.sh" });
  check("a member records a deployment; its release is found from the commit", r.status === 201 && r.json?.release === "v0.2.0" && r.json.state === "success" && r.json.created_by === bo && r.json.environment === "pando-dev");
  record("deployment.json", "Deployment", "POST .../repos/{repo}/deployments", r.status, r.json);
  r = await call("POST", `${base}/deployments`, S, { environment: "staging", sha: main1, state: "failure" });
  check("one with no release at its commit, failed", r.status === 201 && r.json?.release === null && r.json.state === "failure");
  r = await call("POST", `${base}/deployments`, S, { environment: "pando-dev", sha: main1, release: "v9.9.9" });
  check("naming a release that is not published is refused", r.status === 404);
  r = await call("POST", `${base}/deployments`, S, { environment: "Pando Dev", sha: main1 });
  check("an environment's name is checked", r.status === 400);
  r = await call("GET", `${base}/deployments?environment=pando-dev`, S);
  check("deployments of one environment, newest first", r.status === 200 && r.json?.deployments?.length === 1 && r.json.deployments[0].release === "v0.2.0");
  record("deployments.json", "DeploymentList", "GET .../repos/{repo}/deployments?environment=pando-dev", r.status, r.json);
  check("all of them", (await call("GET", `${base}/deployments`, S)).json?.deployments?.map((d) => d.environment).join() === "staging,pando-dev");
  dl = await fetch(`${URL_}/healthz`);
  const up = await dl.text();
  const hz = await (await fetch(`${URL_}/healthz`, { headers: { accept: "application/json" } })).json();
  check("/healthz still answers ok (the docs' Status page reads it); as JSON it names the version, and the commit when deployed with --tag <sha>", up === "ok\n" && hz.ok === true && /^[0-9a-f-]{36}$/.test(hz.version ?? "") && hz.commit === null, JSON.stringify(hz));

  cmd = pando(["help"]);
  check("pando help lists pando release", /pando release list \| view/.test(cmd.stderr) && /pando release create <tag>/.test(cmd.stderr), said(cmd));
} catch (err) {
  check("no unexpected error", false, describeError(err));
} finally {
  check("this run's repositories are deleted", await tw.cleanup());
  server.close();
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((x) => !x).length;

console.log(`\n${results.length - failed}/${results.length} checks passed`);

process.exit(failed ? 1 : 0);
