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
// restores root files, breaks pando.toml (checks unknown), records every route the contract covers and every
// socket frame, then makes an org (with two more people), makes a repo in it and moves the monorepo into it,
// and deletes both monorepos, pass or fail (an org can't be deleted yet). Tokens are stripped before anything is written; credentials stay in
// memory. Git runs with a temp HOME, no system config and no keychain.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

/** The monorepo's name now: the rename and the transfer near the end change it, and the cleanup deletes by it. */
let current = full;

/** Other monorepos the run made (in the org), deleted at the end. */
const others = [];

// A stand-in for Buildkite's REST API on this machine (an ephemeral port): the connection's api_url points here, so the
// CI routes that read the service (configuration, log, annotations, artifacts, Rebuild, Cancel, Retry) answer for real.
// The Worker sends its BUILDKITE_API_TOKEN here as a Bearer; it is never kept or printed.
const bkPipeline = (slug) => ({
  id: `pl-${slug}`, url: `https://api.buildkite.com/v2/organizations/o/pipelines/${slug}`, web_url: `https://buildkite.com/o/${slug}`,
  name: slug, slug, repository: "https://example.invalid/web.git", default_branch: "main", visibility: "private",
});

const bkBuild = (slug, n, o) => ({
  id: `bld-${slug}-${n}`, url: `https://api.buildkite.com/v2/organizations/o/pipelines/${slug}/builds/${n}`, web_url: `https://buildkite.com/o/${slug}/builds/${n}`,
  number: n, state: o.state, blocked: false, message: o.message ?? "a build", commit: o.commit ?? "HEAD", branch: o.branch ?? "main", env: {}, source: "api",
  creator: null, meta_data: o.meta_data ?? {}, created_at: new Date().toISOString(), scheduled_at: new Date().toISOString(), started_at: null, finished_at: null,
});

const bkJob = (id, key, state) => ({
  id, type: "script", name: key, step_key: key, state, web_url: `https://buildkite.com/o/web/builds/1#${id}`, soft_failed: false, exit_status: null,
  created_at: new Date().toISOString(), started_at: null, finished_at: null, retried: false,
});

const bkFixtures = {
  configuration: "steps:\n  - label: lint\n    key: lint\n    command: npm run lint\n",
  log: "$ npm run lint\n\n> lint\n> oxlint --deny-warnings\n\nFound 0 warnings and 0 errors.\n",
  annotations: [{ id: "ann-1", context: "lint-summary", style: "success", body_html: "<p><strong>0</strong> findings</p>", created_at: "2026-10-04T00:00:00Z", updated_at: "2026-10-04T00:00:00Z" }],
  artifacts: [{ id: "art-1", job_id: "job-lint-1", url: "x", download_url: "x", state: "finished", path: "reports/lint.txt", dirname: "reports", filename: "lint.txt", mime_type: "text/plain", file_size: 412, sha1sum: "0".repeat(40) }],
};

let bkNext = 2;

const bk = createServer((req, res) => {
  let raw = "";

  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const json = (code, v) => res.writeHead(code, { "content-type": "application/json", "ratelimit-remaining": "40", "ratelimit-reset": "20" }).end(JSON.stringify(v));
    let m;

    if ((m = /^\/v2\/organizations\/o\/pipelines\/([^/]+)\/builds$/.exec(u.pathname)) && req.method === "POST") {
      const body = JSON.parse(raw);

      return json(201, { ...bkBuild(m[1], bkNext++, { state: "scheduled", commit: body.commit, branch: body.branch, message: body.message, meta_data: body.meta_data }), pipeline: bkPipeline(m[1]) });
    }

    if ((m = /^\/v2\/organizations\/o\/pipelines\/([^/]+)\/builds\/(\d+)\/cancel$/.exec(u.pathname)) && req.method === "PUT") {
      return json(200, { ...bkBuild(m[1], Number(m[2]), { state: "canceling" }), pipeline: bkPipeline(m[1]) });
    }

    if ((m = /\/builds\/\d+\/jobs\/([^/]+)\/retry$/.exec(u.pathname)) && req.method === "PUT") return json(200, bkJob(`${m[1]}-retry`, "lint", "scheduled"));

    if (/\/builds\/\d+\/jobs\/[^/]+\/log$/.test(u.pathname)) return res.writeHead(200, { "content-type": "text/plain" }).end(bkFixtures.log);

    if (/\/builds\/\d+\/annotations$/.test(u.pathname)) return json(200, bkFixtures.annotations);

    if (/\/builds\/\d+\/artifacts$/.test(u.pathname)) return json(200, bkFixtures.artifacts);

    if ((m = /^\/v2\/organizations\/o\/pipelines\/([^/]+)$/.exec(u.pathname))) return json(200, { ...bkPipeline(m[1]), configuration: bkFixtures.configuration });
    json(404, { message: "Not Found" });
  });
});

await new Promise((resolve) => bk.listen(0, "127.0.0.1", resolve));

const bkApiUrl = `http://127.0.0.1:${bk.address().port}`;

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

  // The row updates the web patches from: one kind:<kind> topic per row kind (ROW_KINDS in src/stream.ts).
  const rowTopics = ["branch.updated", "push", "branch.opened", "merged", "status", "machine.updated", "ci.build", "ci.job", "ci.connection"].map((k) => `kind:${k}`).join(",");
  const rowSocket = openSocket(`/v1/monorepos/${full}/events?topics=${rowTopics}`, secret);

  sockets.push(rowSocket);

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
  // Adds merged.txt with other bytes: once feat/merge-me lands, its dry run conflicts on it (Branch.conflict_paths).
  git(["checkout", "-qb", "feat/clash"], src);
  commit(src, "merged.txt", "clash\n", "Add the merged file another way");
  git(["push", "-q", clone, "feat/clash"], src);
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
  r = await call("POST", `/v1/monorepos/${full}/ci/connections`, secret, { service: "buildkite", organization: "o", api_url: bkApiUrl });

  const webhookToken = r.json?.webhook_token;
  const connectionId = r.json?.connection?.id;

  // The token is shown in this answer once; the recording keeps its place, never its value.
  record("ci-connected.json", "CiConnected", "POST .../ci/connections (the webhook token is replaced here)", r.status, { ...r.json, webhook_token: "<webhook-token>" });
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
  // A monorepo's pages: the monorepo, repos, members, machines; branches, commits, files changed, reviews, checks, CI.
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
    ["branch-diff.json", "BranchDiff", "GET .../branches/{branch}/diff?patches=1 (Files changed)", `${repoPath}/branches/feat%2Fready/diff?patches=1`],
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
  r = await call("GET", `${base}/heads`, secret);
  record("heads.json", "HeadList", "GET .../heads (after the merges: main's title)", r.status, r.json);

  // feat/clash after feat/merge-me landed: its dry run conflicts on merged.txt (computed on the read when stale).
  const clash = await waitFor(async () => {
    const b = await call("GET", `${repoPath}/branches/feat%2Fclash?fresh=1`, secret);

    return b.json?.mergeable === "conflicts" ? b : null;
  }, 60_000);

  if (clash === null) throw new Error("feat/clash never showed its conflicts");
  record("branch-conflicts.json", "Branch", "GET .../branches/{branch} (conflicting: conflict_paths)", clash.status, clash.json);

  // A project's files at main: the root folder, each entry's last commit, the root's history (merges carry merged_branch), one file's history.
  r = await call("GET", `${repoPath}/tree?ref=main`, secret);
  record("tree.json", "TreePage", "GET .../repos/{repo}/tree?ref=main", r.status, r.json);

  const lastCommits = await waitFor(async () => {
    const l = await call("GET", `${repoPath}/tree/last-commits?ref=main`, secret);

    return l.json?.complete ? l : null;
  }, 60_000);

  if (lastCommits === null) throw new Error("last commits never completed");
  record("last-commits.json", "LastCommits", "GET .../repos/{repo}/tree/last-commits?ref=main", lastCommits.status, lastCommits.json);
  r = await call("GET", `${repoPath}/history?ref=main`, secret);
  record("history.json", "HistoryPage", "GET .../repos/{repo}/history?ref=main", r.status, r.json);
  r = await call("GET", `${repoPath}/history?ref=main&path=merged.txt`, secret);
  record("history-path.json", "HistoryPage", "GET .../repos/{repo}/history?ref=main&path=merged.txt", r.status, r.json);
  r = await call("GET", `${base}/worktrees?repo=projects%2Fweb`, secret);
  record("worktrees.json", "WorktreeList", "GET .../worktrees?repo=projects/web", r.status, r.json);

  // One build and its jobs (lint, from the webhook above).
  const buildId = (await call("GET", `${base}/ci/builds?branch=feat%2Fready`, secret)).json?.builds?.[0]?.id;

  if (!buildId) throw new Error("no build to read");
  r = await call("GET", `${base}/ci/builds/${encodeURIComponent(buildId)}`, secret);
  record("ci-build.json", "CiBuildDetail", "GET .../ci/builds/{build} (with its jobs)", r.status, r.json);

  // The CI tab, a pipeline's page, and a build's details read from the service (the stand-in above).
  const buildPath = `${base}/ci/builds/${encodeURIComponent(buildId)}`;

  for (const [file, schema, route, path] of [
    ["ci.json", "CiOverview", "GET .../ci", `${base}/ci`],
    ["ci-pipeline.json", "CiPipelinePage", "GET .../ci/pipelines/{pipeline}", `${base}/ci/pipelines/web`],
    ["ci-job-log.json", "CiJobLog", "GET .../ci/builds/{build}/jobs/{job}/log", `${buildPath}/jobs/job-lint-1/log`],
    ["ci-annotations.json", "CiAnnotationList", "GET .../ci/builds/{build}/annotations", `${buildPath}/annotations`],
    ["ci-artifacts.json", "CiArtifactList", "GET .../ci/builds/{build}/artifacts", `${buildPath}/artifacts`],
  ]) {
    r = await call("GET", path, secret);
    record(file, schema, route, r.status, r.json);
  }

  r = await call("POST", `${buildPath}/jobs/job-lint-1/retry`, secret, {});
  record("ci-retried.json", "CiJobAnswer", "POST .../ci/builds/{build}/jobs/{job}/retry", r.status, r.json);
  r = await call("POST", `${buildPath}/rebuild`, secret, {});
  record("ci-rebuilt.json", "CiBuildAnswer", "POST .../ci/builds/{build}/rebuild", r.status, r.json);

  const rebuilt = r.json?.build?.id;

  if (!rebuilt) throw new Error(`no rebuild: ${r.status} ${scrub(JSON.stringify(r.json))}`);
  r = await call("POST", `${base}/ci/builds/${encodeURIComponent(rebuilt)}/cancel`, secret, {});
  record("ci-canceled.json", "CiBuildAnswer", "POST .../ci/builds/{build}/cancel (the rebuild, still scheduled)", r.status, r.json);

  // New build of feat/ready, then the build page's lookup by pipeline and number.
  r = await call("POST", `${base}/ci/pipelines/web/builds`, secret, { branch: "feat/ready" });
  record("ci-started.json", "CiBuildAnswer", "POST .../ci/pipelines/{pipeline}/builds {branch} (New build)", r.status, r.json);

  const startedNumber = r.json?.build?.number;

  if (!startedNumber) throw new Error(`no new build: ${r.status} ${scrub(JSON.stringify(r.json))}`);
  r = await call("GET", `${base}/ci/builds?pipeline=web&number=${startedNumber}`, secret);
  record("ci-build-by-number.json", "CiBuildList", "GET .../ci/builds?pipeline=&number= (a build page's address)", r.status, r.json);

  // Add pipeline: a buildkite hook on projects/web (its builds go to the stand-in).
  r = await call("POST", `${repoPath}/hooks`, secret, { type: "buildkite", buildkite: { organization: "o", pipeline: "web", api_url: `${bkApiUrl}/v2/organizations/o/pipelines/web/builds` } });
  record("hook.json", "Hook", "POST .../repos/{repo}/hooks {type: buildkite} (Add pipeline)", r.status, r.json);

  // Members and Your machines: an invite waiting for ben's first sign-in, the invite list, the person's credentials.
  r = await call("POST", `${base}/invites`, secret, { email: "ben@example.com", role: "member" });
  record("invite.json", "InviteResult", "POST .../invites (no one has signed in with it yet: invited)", r.status, r.json);
  r = await call("GET", `${base}/invites`, secret);
  record("invites.json", "InviteList", "GET .../invites", r.status, r.json);
  r = await call("GET", "/v1/user/credentials", secret);
  record("credentials.json", "CredentialList", "GET /v1/user/credentials", r.status, r.json);

  // A second member (added by login: an invite only adds at once someone who signed in through WorkOS), then removed. Ben's invite is revoked.
  r = await call("POST", "/v1/users", BOOT, { login: `bo-${id}`, name: "Bo Diaz" });

  if (r.status !== 201) throw new Error(`no second user: ${r.status}`);
  r = await call("PUT", `${base}/members/bo-${id}`, secret, { role: "member" });

  if (r.status !== 200) throw new Error(`bo not added: ${r.status}`);
  r = await call("DELETE", `${base}/members/bo-${id}`, secret);
  record("member-removed.json", "NoContent", "DELETE .../members/{login}", r.status, r.json);
  r = await call("DELETE", `${base}/invites/${encodeURIComponent("ben@example.com")}`, secret);
  record("invite-revoked.json", "NoContent", "DELETE .../invites/{email}", r.status, r.json);

  // Your machines: a sandbox credential (its secret is in the answer only, never kept), revoked.
  r = await call("POST", "/v1/user/credentials", secret, { name: "sandbox-1", kind: "sandbox" });

  const sandbox = r.json?.id;

  if (!sandbox) throw new Error(`no sandbox credential: ${r.status}`);
  r = await call("DELETE", `/v1/user/credentials/${encodeURIComponent(sandbox)}`, secret);
  record("credential-revoked.json", "NoContent", "DELETE /v1/user/credentials/{id}", r.status, r.json);

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

  r = await call("DELETE", `${base}/ci/connections/${encodeURIComponent(connectionId)}`, secret);
  record("ci-disconnected.json", "NoContent", "DELETE .../ci/connections/{connection}", r.status, r.json);

  // The row frames, one of each shape (kind, collection, op, full or partial), and a resync for a seq past the head.
  const rowsBeyond = openSocket(`/v1/monorepos/${full}/events?topics=${rowTopics}&since=999999`, secret);

  sockets.push(rowsBeyond);
  await waitFor(() => rowsBeyond.frames.some((f) => f.type === "resync") && rowSocket.frames.some((f) => f.kind === "ci.connection" && f.op === "delete"), 10_000);

  const rowFrames = [];
  const rowKept = new Set();

  for (const frame of [...rowSocket.frames, ...rowsBeyond.frames]) {
    const key = frame.type === "event" ? `${frame.kind}|${frame.collection}|${frame.op}|${frame.partial}` : frame.type;

    if (frame.type === "pong" || rowKept.has(key)) continue;

    rowKept.add(key);
    rowFrames.push(frame);
  }

  record("monorepo-event-frames.json", "MonorepoEventFrame[]", "GET /v1/monorepos/{owner}/{monorepo}/events?topics=kind:<row kinds>[&since=] (WebSocket)", 101, rowFrames);

  // Required checks unknown: a pando.toml that does not parse, merged into the meta layer. Reads answer with the list null and why; an unforced merge is refused.
  const metaDir = join(work, "meta-clone");

  git(["clone", "-q", (await call("GET", `${base}/repos/meta`, secret)).json?.clone_url, metaDir], work);
  git(["checkout", "-qb", "break-config"], metaDir);
  commit(metaDir, ".pando/pando.toml", '[repos."projects/web"]\nrequired_checks = ["ci/test"\n', "Break pando.toml");
  git(["push", "-q", "origin", "break-config"], metaDir);
  r = await call("POST", `${base}/repos/meta/branches/break-config/merge`, secret);

  if (r.status !== 200) throw new Error(`the broken pando.toml did not merge: ${r.status}`);
  r = await call("GET", `${repoPath}/branches/feat%2Fclash`, secret);
  record("branch-checks-unknown.json", "Branch", "GET .../branches/{branch} (pando.toml broken: checks unknown, required null)", r.status, r.json);
  const clashHead = r.json?.head;

  r = await call("GET", `${repoPath}/commits/${clashHead}/status`, secret);
  record("status-checks-unknown.json", "Checks", "GET .../repos/{repo}/commits/{ref}/status (pando.toml broken)", r.status, r.json);
  r = await call("GET", repoPath, secret);
  record("repo-checks-unknown.json", "Repo", "GET .../repos/{repo} (pando.toml broken: required_checks null, checks_unknown)", r.status, r.json);
  r = await call("GET", `${base}/ci`, secret);
  record("ci-checks-unknown.json", "CiOverview", "GET .../ci (pando.toml broken: required checks null)", r.status, r.json);
  r = await call("POST", `${repoPath}/branches/feat%2Fclash/merge`, secret, { expected_head: clashHead });
  record("merge-checks-unknown.json", "ErrorBody", "POST .../branches/{branch}/merge (pando.toml broken: 503 checks_unknown)", r.status, r.json);

  // Settings: rename, last (the old name keeps working; the cleanup deletes by the new one).
  r = await call("PATCH", base, secret, { name: `${name}-renamed` });
  record("renamed.json", "MonorepoRenamed", "PATCH /v1/monorepos/{owner}/{monorepo} {name}", r.status, r.json);

  if (r.status === 200) current = r.json.full_name;

  // Organizations: whose /{name} is; an org with bo (a member) and an invite; a repo made in it; the monorepo moved
  // into it, where ana is an owner both ways, bo is in by the org and cy by a row of his own.
  const org = `org-${id}`;

  r = await call("GET", `/v1/users/${login}`, secret);
  record("owner-user.json", "Owner", "GET /v1/users/{name} (a person)", r.status, r.json);
  r = await call("POST", "/v1/orgs", secret, { login: org, name: "Rec Org" });
  record("org.json", "Org", "POST /v1/orgs", r.status, r.json);

  if (r.status !== 201) throw new Error(`no org: ${r.status} ${scrub(JSON.stringify(r.json))}`);
  r = await call("PATCH", `/v1/orgs/${org}`, secret, { description: "A recorded organization", website: "https://example.com" });
  record("org-patched.json", "Org", "PATCH /v1/orgs/{org}", r.status, r.json);
  r = await call("GET", `/v1/users/${org}`, secret);
  record("owner-org.json", "Owner", "GET /v1/users/{name} (an org)", r.status, r.json);
  r = await call("PUT", `/v1/orgs/${org}/members/bo-${id}`, secret, { role: "member" });
  record("org-member.json", "OrgMember", "PUT /v1/orgs/{org}/members/{login}", r.status, r.json);
  r = await call("GET", `/v1/orgs/${org}/members`, secret);
  record("org-members.json", "OrgMemberList", "GET /v1/orgs/{org}/members", r.status, r.json);
  r = await call("GET", "/v1/user/orgs", secret);
  record("orgs.json", "OrgList", "GET /v1/user/orgs", r.status, r.json);
  r = await call("POST", `/v1/orgs/${org}/invites`, secret, { email: "cy@example.com", role: "member" });
  record("org-invite.json", "OrgInviteResult", "POST /v1/orgs/{org}/invites (no one has signed in with it yet: invited)", r.status, r.json);
  r = await call("GET", `/v1/orgs/${org}/invites`, secret);
  record("org-invites.json", "InviteList", "GET /v1/orgs/{org}/invites", r.status, r.json);
  r = await call("POST", "/v1/monorepos", secret, { name: `in-${id}`, owner: org, kind: "repo" });
  record("monorepo-created.json", "MonorepoCreated", "POST /v1/monorepos {name, owner: <org>, kind: repo}", r.status, r.json);

  if (r.status === 201) others.push(r.json.monorepo.full_name);
  r = await call("POST", "/v1/users", BOOT, { login: `cy-${id}`, name: "Cy Ortiz" });

  if (r.status !== 201) throw new Error(`no third user: ${r.status}`);
  await call("PUT", `/v1/monorepos/${current}/members/cy-${id}`, secret, { role: "member" });
  r = await call("PATCH", `/v1/monorepos/${current}`, secret, { owner: org });
  record("transferred.json", "MonorepoRenamed", "PATCH /v1/monorepos/{owner}/{monorepo} {owner: <org>}", r.status, r.json);

  if (r.status !== 200) throw new Error(`no transfer: ${r.status} ${scrub(JSON.stringify(r.json))}`);
  current = r.json.full_name;
  r = await call("GET", `/v1/monorepos/${current}/members`, secret);
  record("members-org.json", "MemberList", "GET .../members (an org's monorepo: via both, org and direct)", r.status, r.json);
  r = await call("GET", `/v1/monorepos?owner=${org}`, secret);
  record("monorepos-owner.json", "MonorepoList", "GET /v1/monorepos?owner=<org>", r.status, r.json);
  r = await call("GET", `/v1/monorepos?owner=${org}&summary=1`, secret);
  record("monorepos-owner-summary.json", "MonorepoSummaryList", "GET /v1/monorepos?owner=<org>&summary=1", r.status, r.json);
  r = await call("GET", `/v1/events?owner=${org}&limit=5`, secret);
  record("events-owner.json", "EventsPage", "GET /v1/events?owner=<org>&limit=5", r.status, r.json);
  r = await call("DELETE", `/v1/orgs/${org}/members/bo-${id}`, secret);
  record("org-member-removed.json", "NoContent", "DELETE /v1/orgs/{org}/members/{login}", r.status, r.json);
  console.log(`recorded ${written.length} files for ${monorepoId}`);
} catch (error) {
  failed = true;
  console.error(scrub(error instanceof Error ? error.message : String(error)));
} finally {
  for (const socket of sockets) socket.ws.close();

  for (const name of made ? [current, ...others] : []) {
    const d = await call("DELETE", `/v1/monorepos/${name}?confirm=${name}`, secret);

    console.log(`deleted ${name}: ${d.status}`);

    if (d.status >= 300) failed = true;
  }

  rmSync(work, { recursive: true, force: true });
  bk.close();
}

process.exit(failed ? 1 : 0);
