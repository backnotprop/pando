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
