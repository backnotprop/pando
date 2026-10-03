// Records real /v1 responses for the contract's decode check
// (check-recorded.ts), from a local wrangler dev of the Worker with the
// remote Artifacts binding, the way the suites run it. Never pando-dev.
//
//   cd worker
//   npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to <dir>
//   npx wrangler dev --port 8843 --persist-to <dir> --var FEED_TICK_MS:500
//   PANDO_URL=http://localhost:8843 PANDO_BOOTSTRAP=<that server's> node ../packages/contract/scripts/record.mjs
//
// It makes one monorepo (rec-<time>) and its user, starts its meta layer
// with a .pando/pando.toml that requires the check ci/test, pushes four
// branches, posts statuses, a review and a worktree, feeds a Buildkite build
// in through its webhook, merges (forced, refused, clean), saves and
// restores root files, records every route the contract covers and every
// socket frame, and deletes the monorepo, pass or fail. Tokens are stripped before anything is written; credentials stay in
// memory. Git runs with a temp HOME, no system config and no keychain.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isConnectionReset } from "../../../worker/test/errors.mjs";

const BASE = (process.env.PANDO_URL ?? "http://localhost:8843").replace(/\/$/, "");

const BOOT = process.env.PANDO_BOOTSTRAP ?? "";

const OUT = new URL("../recorded/", import.meta.url);

if (BOOT === "") {
  console.error("Set PANDO_BOOTSTRAP to the dev server's bootstrap secret.");
  process.exit(2);
}

const scrub = (text) =>
  text
    .replace(/pando_[a-f0-9]{20,}/g, "<credential>")
    .replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<artifacts-token>")
    .replace(/pst1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<status-token>")
    .replace(/\/\/[^/@\s]+@/g, "//<credentials>@");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, path, secret, body, extra = {}) {
  const headers = new Headers(extra);

  if (secret !== null) headers.set("authorization", `Bearer ${secret}`);

  const init = { method, headers };

  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }

  // wrangler dev closes idle keep-alive connections; a request on one never reached it, so it is sent again once.
  const res = await fetch(BASE + path, init).catch((error) => {
    if (!isConnectionReset(error)) throw error;

    return fetch(BASE + path, init);
  });

  const text = await res.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { status: res.status, json, headers: res.headers };
}

async function waitFor(probe, ms) {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const value = await probe();

    if (value) return value;

    await sleep(300);
  }

  return null;
}

const written = [];

function record(file, schema, route, status, body) {
  const text = scrub(JSON.stringify({ schema, route, status, body }, null, 2));

  writeFileSync(new URL(file, OUT), `${text}\n`);
  written.push(file);
}

function openSocket(path, secret) {
  const socket = { frames: [], open: false, ws: new WebSocket(BASE.replace(/^http/, "ws") + path, { headers: { authorization: `Bearer ${secret}` } }) };

  socket.ws.onopen = () => {
    socket.open = true;
  };

  socket.ws.onmessage = (message) => {
    if (message.data === "pong") return;

    socket.frames.push(JSON.parse(message.data));
  };

  return socket;
}

const work = mkdtempSync(join(tmpdir(), "pando-record-"));

const id = Date.now().toString(36);

const login = `rec-${id}`;

const name = `rec-${id}`;

const full = `${login}/${name}`;

const sockets = [];

let secret = null;

let made = false;

let failed = false;

const git = (args, cwd) => {
  const r = spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: work,
      GIT_TERMINAL_PROMPT: "0",
      PANDO_SECRET: secret ?? "",
      GIT_AUTHOR_NAME: "Ana Lima",
      GIT_AUTHOR_EMAIL: "ana@pando.invalid",
      GIT_COMMITTER_NAME: "Ana Lima",
      GIT_COMMITTER_EMAIL: "ana@pando.invalid",
    },
  });

  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${scrub(`${r.stdout}${r.stderr}`)}`);

  return r.stdout.trim();
};

const commit = (src, file, text, message) => {
  writeFileSync(join(src, file), text);
  git(["add", "-A"], src);
  git(["commit", "-qm", message], src);

  return git(["rev-parse", "HEAD"], src);
};

const blobSha = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

try {
  mkdirSync(OUT, { recursive: true });

  const user = await call("POST", "/v1/users", BOOT, { login, name: "Ana Lima", credential_name: "ana-mbp" });

  secret = user.json?.credential?.secret ?? null;

  if (secret === null) throw new Error(`no user: ${user.status}`);

  let r = await call("GET", "/v1/user", secret);

  record("me.json", "Me", "GET /v1/user", r.status, r.json);
  r = await call("GET", "/v1/user", null);
  record("error-401.json", "ErrorBody", "GET /v1/user (no credential)", r.status, r.json);
  r = await call("POST", "/v1/monorepos", secret, { name });

  if (r.status !== 201) throw new Error(`no monorepo: ${r.status} ${scrub(JSON.stringify(r.json))}`);

  made = true;

  const monorepoId = r.json.monorepo.id;

  r = await call("POST", `/v1/monorepos/${full}/repos`, secret, { path: "projects/web" });

  const clone = r.json?.clone_url;

  if (!clone) throw new Error(`no repo: ${r.status}`);

  const live = openSocket("/v1/events", secret);

  sockets.push(live);
  await waitFor(() => live.open, 10_000);
  live.ws.send(JSON.stringify({ type: "hello", since: 0 }));

  const monorepoFeed = openSocket(`/v1/monorepos/${full}/events?topics=feed`, secret);

  sockets.push(monorepoFeed);

  // The meta layer's first upload (pando init): .pando/pando.toml requires ci/test for projects/web.
  const metaPath = `/v1/monorepos/${full}/meta`;
  const meta = openSocket(`${metaPath}/socket`, secret);

  sockets.push(meta);
  await waitFor(() => meta.open, 10_000);
  meta.ws.send(JSON.stringify({ type: "hello", since: 0, author: "Ana Lima <ana@pando.invalid>", machine: "ana-mbp", client: "record/1" }));
  await waitFor(() => meta.frames.find((f) => f.type === "caught_up" && f.more === false), 10_000);
  r = await call("POST", `${metaPath}/init`, secret, { action: "start" });

  if (r.status !== 200) throw new Error(`no first upload: ${r.status}`);

  const toml = Buffer.from('[repos."projects/web"]\nrequired_checks = ["ci/test"]\n');

  meta.ws.send(JSON.stringify({ type: "save", id: "init", path: ".pando/pando.toml", base_version: 0, sha: blobSha(toml), bytes: toml.toString("base64") }));

  if (!(await waitFor(() => meta.frames.find((f) => f.type === "accepted" && f.id === "init"), 10_000))) throw new Error("pando.toml not accepted");

  await call("POST", `${metaPath}/init`, secret, { action: "done" });

  if (!(await waitFor(async () => (await call("GET", `${metaPath}/status`, secret)).json?.last_commit, 60_000))) throw new Error("the first upload was never committed");

  // Code: main, then four branches: ready, failing, merged, and one to delete.
  const src = join(work, "web");

  mkdirSync(src);
  git(["init", "-q"], src);
  commit(src, "README.md", "# web\n", "First commit");
  git(["push", "-q", clone, "main"], src);
  git(["checkout", "-qb", "feat/ready"], src);

  const readyHead = commit(src, "ready.txt", "ready\n", "Add the ready file\n\nSo the page has something to show.\n\nCo-authored-by: Claude <noreply@anthropic.com>\nPando-Machine: ana-mbp");

  git(["push", "-q", clone, "feat/ready"], src);
  git(["checkout", "-q", "main"], src);
  git(["checkout", "-qb", "feat/failing"], src);

  const failingHead = commit(src, "failing.txt", "failing\n", "Add the failing file");

  git(["push", "-q", clone, "feat/failing"], src);
  git(["checkout", "-q", "main"], src);
  git(["checkout", "-qb", "feat/merge-me"], src);
  commit(src, "merged.txt", "merged\n", "Add the merged file");
  git(["push", "-q", clone, "feat/merge-me"], src);
  git(["checkout", "-q", "main"], src);
  git(["checkout", "-qb", "chore/gone"], src);
  commit(src, "gone.txt", "gone\n", "A branch to delete");
  git(["push", "-q", clone, "chore/gone"], src);
  git(["push", "-q", clone, "--delete", "chore/gone"], src);

  const repoPath = `/v1/monorepos/${full}/repos/projects-web`;

  await call("POST", `${repoPath}/statuses/${failingHead}`, secret, { context: "ci/test", state: "pending" });
  await call("POST", `${repoPath}/statuses/${failingHead}`, secret, { context: "ci/test", state: "failure", description: "2 tests failed" });
  await call("POST", `${repoPath}/statuses/${readyHead}`, secret, { context: "ci/test", state: "pending" });
  await call("POST", `${repoPath}/statuses/${readyHead}`, secret, { context: "ci/test", state: "success", target_url: "https://ci.example/builds/1" });
  await call("POST", `${repoPath}/branches/feat%2Fready/reviews`, secret, { verdict: "approve", body: "Looks right.", comments: [{ path: "ready.txt", line: 1, body: "Good." }] });

  // A Buildkite build of feat/ready, in through its webhook (token header): the build row, and a check `lint` stamped app buildkite.
  r = await call("POST", `/v1/monorepos/${full}/ci/connections`, secret, { service: "buildkite", organization: "o" });

  const webhookToken = r.json?.webhook_token;
  const hookPath = `/v1/integrations/buildkite/${r.json?.connection?.id}`;

  if (!webhookToken) throw new Error(`no ci connection: ${r.status}`);

  const t0 = Date.now();
  const iso = (ms) => new Date(t0 + ms).toISOString();
  const pipeline = { id: "pl-web", url: "https://api.buildkite.com/v2/organizations/o/pipelines/web", web_url: "https://buildkite.com/o/web", name: "web", slug: "web", default_branch: "main" };

  const build = (state, extra = {}) => ({
    id: "bld-web-1", url: "https://api.buildkite.com/v2/organizations/o/pipelines/web/builds/1", web_url: "https://buildkite.com/o/web/builds/1", number: 1, state,
    message: "Add the ready file", commit: readyHead, branch: "feat/ready", meta_data: { pando_monorepo: monorepoId, pando_repo: "projects-web" },
    created_at: iso(0), started_at: null, finished_at: null, ...extra,
  });

  const job = { id: "job-lint-1", type: "script", name: "lint", step_key: "lint", state: "passed", web_url: "https://buildkite.com/o/web/builds/1#job-lint-1", soft_failed: false, exit_status: 0, created_at: iso(500), started_at: iso(1000), finished_at: iso(9000), retried: false };
  const webhook = (event, payload) => call("POST", hookPath, null, { event, ...payload }, { "x-buildkite-event": event, "x-buildkite-token": webhookToken });

  for (const [event, payload] of [
    ["build.scheduled", { build: build("scheduled"), pipeline }],
    ["job.finished", { build: build("running", { started_at: iso(1000) }), pipeline, job }],
    ["build.finished", { build: build("passed", { started_at: iso(1000), finished_at: iso(10000) }), pipeline }],
  ]) {
    r = await webhook(event, payload);

    if (r.json?.result !== "recorded") throw new Error(`webhook ${event} not recorded: ${r.status} ${scrub(JSON.stringify(r.json))}`);
  }

  const merged = await waitFor(async () => {
    const m = await call("POST", `${repoPath}/branches/feat%2Fmerge-me/merge?force=1`, secret, {});

    return m.status === 200 || m.status === 201 ? m : null;
  }, 60_000);

  if (merged === null) throw new Error("the merge never went through");

  await call("PUT", `/v1/monorepos/${full}/worktrees/wt-${id}`, secret, { kind: "sparse", repo: "projects/web", branch: "feat/ready", path: "/Users/ana/pando/projects/web/worktrees/feat-ready", machine: "ana-mbp" });

  // Root files, saved over the meta socket as a machine would.

  const files = [
    ["README.md", "# rec\n\nRoot files of a recorded monorepo.\n"],
    ["docs/guide.md", "# Guide\n"],
    ["docs/deep/notes.md", "Notes.\n"],
  ];

  for (const [index, [path, text]] of files.entries()) {
    const bytes = Buffer.from(text);

    meta.ws.send(JSON.stringify({ type: "save", id: `s${index}`, path, base_version: 0, sha: blobSha(bytes), bytes: bytes.toString("base64") }));
  }

  const accepted = await waitFor(() => meta.frames.filter((f) => f.type === "accepted" && f.id !== "init").length === files.length, 15_000);

  if (!accepted) throw new Error(`root files not accepted: ${scrub(JSON.stringify(meta.frames))}`);

  // Wait for the derived answers: needs rows, the summary line, and lines of every kind with their fuller push summaries.
  const needs = await waitFor(async () => {
    const n = await call("GET", "/v1/branches", secret);
    const states = new Set(n.json?.branches?.map((b) => b.state));

    return states.has("ready") && states.has("failing") ? n : null;
  }, 90_000);

  if (needs === null) throw new Error("needs rows never came");

  record("needs.json", "NeedsPage", "GET /v1/branches", needs.status, needs.json);

  const summary = await waitFor(async () => {
    const s = await call("GET", "/v1/monorepos?summary=1", secret);
    const line = s.json?.monorepos?.[0];

    return line?.needs?.ready > 0 && line.needs.failing > 0 ? s : null;
  }, 60_000);

  if (summary === null) throw new Error("the summary line never counted the needs");

  record("monorepos-summary.json", "MonorepoSummaryList", "GET /v1/monorepos?summary=1", summary.status, summary.json);
  r = await call("GET", "/v1/monorepos", secret);
  record("monorepos.json", "MonorepoList", "GET /v1/monorepos", r.status, r.json);

  const kinds = ["push", "branch.opened", "branch.deleted", "merged", "review", "status", "worktree.reported", "meta.saved"];

  const page = await waitFor(async () => {
    const p = await call("GET", "/v1/events?limit=200", secret);
    const seen = new Set(p.json?.events?.map((e) => e.kind));
    const counted = p.json?.events?.some((e) => e.kind === "branch.opened" && e.summary?.commits !== null);

    return kinds.every((k) => seen.has(k)) && counted ? p : null;
  }, 60_000);

  if (page === null) throw new Error("the activity page never had every kind");

  record("events.json", "EventsPage", "GET /v1/events?limit=200", page.status, page.json);
  r = await call("GET", `/v1/events?limit=2&in=${encodeURIComponent(full)}`, secret);
  record("events-in.json", "EventsPage", "GET /v1/events?limit=2&in=<owner/name>", r.status, r.json);

  // Socket frames: every kind of event frame, and the others.
  live.ws.send("ping");
  await sleep(1500);

  const frames = [];
  const kept = new Set();

  for (const frame of live.frames.toReversed()) {
    const key = frame.type === "event" ? `event:${frame.event.kind}` : frame.type;

    if (kept.has(key)) continue;

    kept.add(key);
    frames.unshift(frame);
  }

  record("activity-frames.json", "ActivityFrame[]", "GET /v1/events (WebSocket)", 101, frames);

  // The monorepo's own socket on the feed topic: live lines, a replay after feed_since=1, and feed_resync for an n it never reached.
  const replay = openSocket(`/v1/monorepos/${full}/events?topics=feed&feed_since=1`, secret);
  const beyond = openSocket(`/v1/monorepos/${full}/events?topics=feed&feed_since=999999`, secret);

  sockets.push(replay, beyond);
  await waitFor(() => replay.frames.some((f) => f.type === "caught_up") && beyond.frames.some((f) => f.type === "feed_resync"), 10_000);

  const feedFrames = [];
  const feedKept = new Set();

  for (const frame of [...monorepoFeed.frames, ...replay.frames, ...beyond.frames]) {
    const key = frame.type === "feed" ? `feed:${frame.event.kind}` : frame.type;

    if (feedKept.has(key)) continue;

    feedKept.add(key);
    feedFrames.push(frame);
  }

  record("monorepo-feed-frames.json", "MonorepoFeedFrame[]", "GET /v1/monorepos/{owner}/{monorepo}/events?topics=feed[&feed_since=] (WebSocket)", 101, feedFrames);

  r = await call("GET", `${metaPath}/tree?dir=`, secret);
  record("meta-tree-root.json", "MetaTree", "GET .../meta/tree?dir=", r.status, r.json);
  r = await call("GET", `${metaPath}/tree?dir=docs`, secret);
  record("meta-tree-docs.json", "MetaTree", "GET .../meta/tree?dir=docs", r.status, r.json);
  r = await call("GET", `${metaPath}/tree?limit=2`, secret);
  record("meta-tree-page.json", "MetaTree", "GET .../meta/tree?limit=2", r.status, r.json);
  r = await call("GET", `${metaPath}/history?path=README.md`, secret);
  record("meta-history-path.json", "MetaHistory", "GET .../meta/history?path=README.md", r.status, r.json);
  r = await call("GET", `${metaPath}/history?since=0`, secret);
  record("meta-history-since.json", "MetaHistory", "GET .../meta/history?since=0", r.status, r.json);
  r = await call("GET", `${metaPath}/file?path=README.md`, secret);
  record("meta-file-headers.json", "MetaFileHeaders", "GET .../meta/file?path=README.md", r.status, { "x-pando-version": r.headers.get("x-pando-version"), "x-pando-sha": r.headers.get("x-pando-sha") });
  // A monorepo's pages: the monorepo, repos, members, machines; branches, commits, reviews, checks, CI.
  const base = `/v1/monorepos/${full}`;

  for (const [file, schema, route, path] of [
    ["monorepo.json", "MonorepoEntry", "GET /v1/monorepos/{owner}/{monorepo}", base],
    ["repos.json", "RepoList", "GET .../repos", `${base}/repos`],
    ["repo.json", "Repo", "GET .../repos/{repo} (with required_checks)", repoPath],
    ["members.json", "MemberList", "GET .../members", `${base}/members`],
    ["machines.json", "MachineList", "GET .../machines", `${base}/machines`],
    ["branches-open.json", "BranchList", "GET .../repos/{repo}/branches?state=open", `${repoPath}/branches?state=open`],
    ["branch.json", "Branch", "GET .../branches/{branch}", `${repoPath}/branches/feat%2Fready`],
    ["branch-commits.json", "BranchCommits", "GET .../branches/{branch}/commits", `${repoPath}/branches/feat%2Fready/commits`],
    ["reviews.json", "ReviewList", "GET .../branches/{branch}/reviews", `${repoPath}/branches/feat%2Fready/reviews`],
    ["status.json", "Checks", "GET .../repos/{repo}/commits/{ref}/status", `${repoPath}/commits/${readyHead}/status`],
    ["ci-builds.json", "CiBuildList", "GET .../ci/builds?branch=", `${base}/ci/builds?branch=feat%2Fready`],
  ]) {
    r = await call("GET", path, secret);
    record(file, schema, route, r.status, r.json);
  }

  // Merges: the forced one from before; a refused one (ci/test failed: 412 with checks); a clean one.
  record("merge-forced.json", "MergeResult", "POST .../branches/{branch}/merge?force=1", merged.status, merged.json);
  r = await call("POST", `${repoPath}/branches/feat%2Ffailing/merge?force=0`, secret, { expected_head: failingHead });
  record("merge-refused.json", "ErrorBody", "POST .../branches/{branch}/merge (checks not green)", r.status, r.json);
  r = await call("POST", `${repoPath}/branches/feat%2Fready/merge?force=0`, secret, { expected_head: readyHead });
  record("merge.json", "MergeResult", "POST .../branches/{branch}/merge", r.status, r.json);
  r = await call("GET", `${repoPath}/branches?state=merged`, secret);
  record("branches-merged.json", "BranchList", "GET .../repos/{repo}/branches?state=merged", r.status, r.json);

  // Restore: README.md saved again, then written back as it was, then again (unchanged).
  const first = meta.frames.find((f) => f.type === "accepted" && f.path === "README.md")?.version;
  const again = Buffer.from("# rec\n\nEdited.\n");

  meta.ws.send(JSON.stringify({ type: "save", id: "s-again", path: "README.md", base_version: first, sha: blobSha(again), bytes: again.toString("base64") }));
  await waitFor(() => meta.frames.find((f) => f.type === "accepted" && f.id === "s-again"), 10_000);
  r = await call("POST", `${metaPath}/restore`, secret, { path: "README.md", version: first });
  record("meta-restore.json", "Restored", "POST .../meta/restore", r.status, r.json);
  r = await call("POST", `${metaPath}/restore`, secret, { path: "README.md", version: first });
  record("meta-restore-unchanged.json", "Restored", "POST .../meta/restore (already so)", r.status, r.json);
  r = await call("POST", "/v1/logout", null, undefined, { accept: "application/json", origin: BASE });
  record("logout.json", "SignedOut", "POST /v1/logout (Accept: application/json, no session)", r.status, r.json);
  r = await call("GET", `${metaPath}/file?path=absent.md`, secret);
  record("error-404.json", "ErrorBody", "GET .../meta/file?path=absent.md", r.status, r.json);
  console.log(`recorded ${written.length} files for ${monorepoId}`);
} catch (error) {
  failed = true;
  console.error(scrub(error instanceof Error ? error.message : String(error)));
} finally {
  for (const socket of sockets) socket.ws.close();

  if (made) {
    const d = await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, secret);

    console.log(`deleted ${full}: ${d.status}`);

    if (d.status >= 300) failed = true;
  }

  rmSync(work, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
