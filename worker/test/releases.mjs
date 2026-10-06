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
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch } from "./errors.mjs";
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

const call = (method, path, secret, body, headers = {}) => request(URL_, method, path, { secret, body, headers, redirect: "manual" });

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

const made = [];

let O = null;

let S = null;

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

  if (r.status === 201) made.push(M);
  const url = r.json?.repos?.[0]?.clone_url;
  const base = `/v1/monorepos/${O}/${M}/repos/${M}`;
  r = await call("POST", "/v1/monorepos", S, { name: E, kind: "repo" });

  if (r.status === 201) made.push(E);
  check("two plain repositories made", made.length === 2 && !!url);

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
} catch (err) {
  check("no unexpected error", false, describeError(err));
} finally {
  for (const name of made) {
    const r = await call("DELETE", `/v1/monorepos/${O}/${name}?confirm=${O}/${name}`, S).catch(() => ({ status: 0 }));
    console.log(`deleted ${name}: ${r.status}`);
  }

  server.close();
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((x) => !x).length;

console.log(`\n${results.length - failed}/${results.length} checks passed`);

process.exit(failed ? 1 : 0);
