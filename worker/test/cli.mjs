// The cli's API commands, end to end against `wrangler dev`: the real pando
// binary (go build), a monorepo made with `pando init` (real git through the
// door, real Artifacts), real D1 and Durable Objects, and a local stand-in
// for Buildkite's REST API (as ci.mjs has).
//
//   pando api       placeholders from the folder, -f and -F fields, --input,
//                   --paginate over a paged list, -i, a 4xx on stderr
//   pando ci build  list, view, log, cancel, rebuild; ci job retry; ci run
//   pando monorepo  rename (the folder follows), view by the new name
//   pando members   invites and revoke
//   pando activity  --json; pando branch view; pando hook; pando machine list
//
//   PANDO_URL=http://localhost:8854 node test/cli.mjs
//
// Reads PANDO_BOOTSTRAP and BUILDKITE_API_TOKEN from worker/.dev.vars.
// Credentials and tokens are never printed. Every pando and git run has
// HOME and PANDO_HOME in the test's folder and no system git config, so
// nothing reaches the owner's git config, ~/.pando or the keychain.
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeError, retryResetFetch } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8854").replace(/\/$/, "");

const VARS = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");

const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(VARS)?.[1];

const BK_TOKEN = /^BUILDKITE_API_TOKEN=(.*)$/m.exec(VARS)?.[1];

const scrub = (s) =>
  String(s)
    .replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<token>")
    .replace(/pst1\.[A-Za-z0-9_.-]+/g, "<status-token>")
    .replace(/pando_[a-f0-9]{20,}/g, "<credential>");

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`));
};

// connection: close on each call: between calls the pando runs leave the
// sockets idle for seconds, wrangler dev closes idle ones, and a POST on a
// socket closed under it fails with ECONNRESET (and is not retried).
const call = (method, path, secret, body, headers = {}) => request(URL_, method, path, { secret, body, headers: { connection: "close", ...headers }, redirect: "manual" });

const callRaw = (method, path, raw, headers = {}) => request(URL_, method, path, { raw, headers: { connection: "close", ...headers }, redirect: "manual" });

const waitFor = async (pred, ms = 30_000) => {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await pred();

    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }

  return null;
};

/** JSON from a pando run's stdout, or null. */
const parsed = (run) => {
  try {
    return JSON.parse(run.stdout);
  } catch {
    return null;
  }
};

// ── A stand-in for Buildkite's REST API, and a web hook receiver ──
const bk = { calls: [], badAuth: 0, logs: {}, nextNumber: 100 };

const bkPipeline = (slug) => ({
  id: `pl-${slug}`, url: `https://api.buildkite.com/v2/organizations/o/pipelines/${slug}`, web_url: `https://buildkite.com/o/${slug}`,
  name: slug, slug, repository: "https://example.invalid/repo.git", default_branch: "main", visibility: "private",
});

const bkBuild = (slug, n, o = {}) => ({
  id: `bld-${slug}-${n}`, graphql_id: "x", url: `https://api.buildkite.com/v2/organizations/o/pipelines/${slug}/builds/${n}`,
  web_url: `https://buildkite.com/o/${slug}/builds/${n}`, number: n, state: o.state ?? "scheduled", blocked: false, message: o.message ?? "a build",
  commit: o.commit ?? "HEAD", branch: o.branch ?? "main", env: {}, source: "api", creator: null, meta_data: o.meta_data ?? {},
  created_at: o.created_at ?? new Date().toISOString(), scheduled_at: o.created_at ?? new Date().toISOString(),
  started_at: o.started_at ?? null, finished_at: o.finished_at ?? null,
});

const bkJob = (id, key, o = {}) => ({
  id, graphql_id: "x", type: "script", name: key, step_key: key, state: o.state ?? "scheduled",
  web_url: `https://buildkite.com/o/p/builds/1#${id}`, log_url: "x", raw_log_url: "x", command: "npm test",
  soft_failed: false, exit_status: o.exit_status ?? null, created_at: o.created_at ?? new Date().toISOString(),
  started_at: o.started_at ?? null, finished_at: o.finished_at ?? null, retried: false,
});

const bkApi = (req, raw, res) => {
  const u = new URL(req.url, "http://x");
  bk.calls.push(`${req.method} ${u.pathname}`);

  if (req.headers.authorization !== `Bearer ${BK_TOKEN}`) bk.badAuth++;
  const json = (code, v) => res.writeHead(code, { "content-type": "application/json", "ratelimit-remaining": "40", "ratelimit-reset": "20" }).end(JSON.stringify(v));
  let m;

  if ((m = /^\/v2\/organizations\/o\/pipelines\/([^/]+)\/builds$/.exec(u.pathname)) && req.method === "POST") {
    const body = JSON.parse(raw);

    return json(201, { ...bkBuild(m[1], bk.nextNumber++, { commit: body.commit, branch: body.branch, message: body.message, meta_data: body.meta_data }), pipeline: bkPipeline(m[1]) });
  }

  if ((m = /^\/v2\/organizations\/o\/pipelines\/([^/]+)\/builds\/(\d+)\/cancel$/.exec(u.pathname)) && req.method === "PUT") {
    return json(200, { ...bkBuild(m[1], Number(m[2]), { state: "canceling", commit: bk.commit, branch: "feat-a" }), pipeline: bkPipeline(m[1]) });
  }

  if ((m = /\/builds\/\d+\/jobs\/([^/]+)\/retry$/.exec(u.pathname)) && req.method === "PUT") {
    return json(200, bkJob(`${m[1]}-retry`, "ci", { created_at: new Date(Date.now() + 1000).toISOString() }));
  }

  if ((m = /\/builds\/\d+\/jobs\/([^/]+)\/log$/.exec(u.pathname))) {
    return res.writeHead(200, { "content-type": "text/plain" }).end(bk.logs[m[1]] ?? "no log\n");
  }

  json(404, { message: "Not Found" });
};

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url.startsWith("/v2/")) return bkApi(req, raw, res);

    // Buildkite's create-build for a buildkite hook, and web hook deliveries: taken, not checked here.
    res.writeHead(req.url === "/buildkite" ? 201 : 200, { "content-type": "application/json" }).end("{}");
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));

const port = server.address().port;

const id = Date.now().toString(36);

const work = mkdtempSync(join(tmpdir(), "pando-cli-"));

const SAFE = {
  HOME: join(work, "home"), XDG_CONFIG_HOME: join(work, "home", ".config"), PANDO_HOME: join(work, "pando-home"),
  GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", PANDO_SERVER: "", PANDO_TOKEN: "", PANDO_AGENT: "", PANDO_NO_BROWSER: "1",
  PANDO_MACHINE: "cli-box", PANDO_WORKTREE_KIND: "sparse",
  GIT_AUTHOR_NAME: "Cli Person", GIT_AUTHOR_EMAIL: "cli@pando.invalid", GIT_COMMITTER_NAME: "Cli Person", GIT_COMMITTER_EMAIL: "cli@pando.invalid",
};

mkdirSync(SAFE.HOME);

const bin = join(work, "pando");

/**
 * One run of the built pando, in the test's folder unless cwd says: its exit
 * status, stdout and stderr. Not spawnSync: the stand-in Buildkite answers
 * the Worker from this process, so its event loop must keep running.
 */
const pando = (args, o = {}) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: o.cwd ?? work, env: { ...process.env, ...SAFE } });
    const out = { status: null, stdout: "", stderr: "" };
    child.stdout.on("data", (d) => (out.stdout += d));
    child.stderr.on("data", (d) => (out.stderr += d));
    child.on("close", (code) => resolve({ ...out, status: code }));
    child.stdin.end(o.input ?? "");
  });

const git = (args, cwd) => spawnSync("git", ["-c", "credential.helper=", "-c", "init.defaultBranch=main", ...args], { cwd, env: { ...process.env, ...SAFE }, encoding: "utf8" });

const said = (run) => scrub(`${run.status} ${run.stdout} ${run.stderr}`).trim().slice(0, 300);

const LOGIN = `cli-${id}`;

const NAME = `cli-${id}`;

const RENAMED = `cli2-${id}`;

let S = null;

let full = null;

try {
  S = (await call("POST", "/v1/users", BOOT, { login: LOGIN, credential_name: "cli-box" })).json?.credential?.secret;
  check("a user to sign in as", !!S);
  const cli = fileURLToPath(new URL("../../cli", import.meta.url));
  const built = spawnSync("go", ["build", "-buildvcs=false", "-o", bin, "./cmd/pando"], { cwd: cli, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  check("the cli builds", built.status === 0, built.stderr?.slice(0, 200));
  let r = await pando(["login", "--server", URL_, "--with-credential"], { input: S + "\n" });
  check("pando login --with-credential (piped)", r.status === 0, said(r));

  // A monorepo from a folder: projects/app is a git repo, AGENTS.md a shared file.
  const mono = join(work, NAME);
  const app = join(mono, "projects", "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(mono, "AGENTS.md"), "notes\n");
  writeFileSync(join(app, "main.go"), "package main\n");
  git(["init", "-q"], app);
  git(["add", "-A"], app);
  git(["commit", "-qm", "first"], app);
  const mainSha = git(["rev-parse", "HEAD"], app).stdout.trim();
  bk.commit = mainSha;
  r = await pando(["init", "--yes", "--name", NAME], { cwd: mono });
  full = `${LOGIN}/${NAME}`;
  check("pando init makes the monorepo and pushes main", r.status === 0 && r.stdout.includes(`Pando monorepo ${full} is set up`), said(r));

  // ── pando api ──
  r = await pando(["api", "/monorepos/{owner}/{monorepo}/repos/{repo}"], { cwd: app });
  let j = parsed(r);
  check("pando api GET: {owner}, {monorepo} and {repo} filled from the folder", r.status === 0 && j?.name === "projects-app" && j.path === "projects/app" && j.monorepo === full, said(r));
  check("... compact JSON in a pipe (one line)", r.stdout.trim().split("\n").length === 1);
  r = await pando(["api", "v1/monorepos/{owner}/{monorepo}/repos/{repo}", "--monorepo", full, "--repo", "projects/app"]);
  check("with the /v1 prefix, outside the folder: --monorepo and --repo", r.status === 0 && parsed(r)?.name === "projects-app", said(r));
  r = await pando(["api", "-i", "/user"], { cwd: app });
  check("-i prints the status and headers first", r.status === 0 && r.stdout.startsWith("HTTP/1.1 200 OK\n") && /\nContent-Type: application\/json/i.test(r.stdout) && r.stdout.includes(`"login":"${LOGIN}"`), said(r));

  const branches = "/monorepos/{owner}/{monorepo}/repos/{repo}/branches";
  r = await pando(["api", branches, "-f", "name=feat-a", "-f", "title=A title"], { cwd: app });
  j = parsed(r);
  check("pando api POST with -f: a branch made (POST since there are fields)", r.status === 0 && j?.name === "feat-a" && j.title === "A title" && j.author === LOGIN, said(r));
  r = await pando(["api", "-X", "PATCH", `${branches}/feat-a`, "--input", "-"], { cwd: app, input: JSON.stringify({ description: "from stdin" }) });
  check("--input - sends standard input as the body", r.status === 0 && parsed(r)?.description === "from stdin", said(r));
  r = await pando(["api", "/monorepos/{owner}/{monorepo}/repos/{repo}/hooks", "-f", "type=web", "-f", `url=http://127.0.0.1:${port}/hook`, "-f", "secret=s3cret-s3cret", "-f", "events[]=push", "-f", "events[]=merged"], { cwd: app });
  j = parsed(r);
  check("fields in gh's form: events[]=push and events[]=merged make an array", r.status === 0 && j?.type === "web" && JSON.stringify(j.events) === '["push","merged"]', said(r));
  const webHook = j?.id;

  for (const n of ["b1", "b2", "b3", "b4"]) await pando(["api", branches, "-f", `name=${n}`], { cwd: app });
  r = await pando(["api", `${branches}?limit=2`], { cwd: app });
  j = parsed(r);
  check("one page: 2 branches and a next_cursor", j?.branches?.length === 2 && !!j.next_cursor, said(r));
  r = await pando(["api", `${branches}?limit=2`, "--paginate"], { cwd: app });
  j = parsed(r);
  const names = (j?.branches ?? []).map((b) => b.name).sort().join(",");
  check("--paginate follows next_cursor: all 5 branches in one answer, next_cursor null", r.status === 0 && names === "b1,b2,b3,b4,feat-a" && j.next_cursor === null && j.default_branch === "main", `${names} ${said(r)}`);

  r = await pando(["api", "/monorepos/{owner}/{monorepo}/repos/nope"], { cwd: app });
  let err = null;

  try {
    err = JSON.parse(r.stderr);
  } catch {}

  check("a 404: exit 1, the API's error body on stderr, nothing on stdout", r.status === 1 && err?.error?.code === "not_found" && r.stdout === "", said(r));
  r = await pando(["api"]);
  check("no path: a usage error, exit 2", r.status === 2 && /usage: pando api/.test(r.stderr));
  r = await pando(["api", `${URL_}/v1/user`]);
  check("a full URL is refused (the credential goes only to the signed-in server)", r.status === 2 && /not a URL/.test(r.stderr));

  // ── pando ci: a Buildkite connection on the stand-in, pipeline p on projects/app ──
  const ciBase = `/v1/monorepos/${full}/ci`;
  r = await call("POST", `${ciBase}/connections`, S, { service: "buildkite", organization: "o", api_url: `http://127.0.0.1:${port}` });
  const WH = r.json?.webhook_token;
  const conn = r.json?.connection;
  r = await call("POST", `/v1/monorepos/${full}/repos/projects-app/hooks`, S, { type: "buildkite", buildkite: { organization: "o", pipeline: "p", api_url: `http://127.0.0.1:${port}/buildkite` } });
  check("a Buildkite connection and pipeline p for projects/app", !!WH && r.status === 201);

  const send = (event, payload) => {
    const body = JSON.stringify({ event, ...payload });
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", WH).update(`${ts}.${body}`).digest("hex");

    return callRaw("POST", `/v1/integrations/buildkite/${conn.id}`, body, { "x-buildkite-event": event, "x-buildkite-signature": `timestamp=${ts},signature=${sig}` });
  };

  const t0 = Date.now();
  const iso = (ms) => new Date(t0 + ms).toISOString();
  const b1 = (state, o = {}) => ({ build: bkBuild("p", 1, { state, commit: mainSha, branch: "main", message: "first", created_at: iso(0), ...o }), pipeline: bkPipeline("p") });
  const b2 = (state, o = {}) => ({ build: bkBuild("p", 2, { state, commit: mainSha, branch: "feat-a", message: "second", created_at: iso(5000), ...o }), pipeline: bkPipeline("p") });
  r = await send("build.running", b1("running", { started_at: iso(1000) }));
  const build1 = r.json?.build;
  await send("job.finished", { ...b1("running", { started_at: iso(1000) }), job: bkJob("job-ci-1", "ci", { state: "failed", exit_status: 1, created_at: iso(500), started_at: iso(1000), finished_at: iso(61000) }) });
  await send("job.finished", { ...b1("running", { started_at: iso(1000) }), job: bkJob("job-lint-1", "lint", { state: "passed", exit_status: 0, created_at: iso(600), started_at: iso(1000), finished_at: iso(9000) }) });
  await send("build.finished", b1("failed", { started_at: iso(1000), finished_at: iso(62000) }));
  r = await send("build.running", b2("running", { started_at: iso(6000) }));
  const build2 = r.json?.build;
  check("two builds recorded from Buildkite's webhooks", (build1 ?? "").startsWith("cib_") && (build2 ?? "").startsWith("cib_"));

  r = await pando(["ci", "build", "list", "--json"], { cwd: mono });
  j = parsed(r);
  check("pando ci build list --json: the API's builds, newest first", r.status === 0 && j?.builds?.length === 2 && j.builds[0].id === build2 && j.builds[1].id === build1 && "next_cursor" in j, said(r));
  r = await pando(["ci", "build", "list"], { cwd: mono });
  check("pando ci build list: a table (#1 failed, #2 running, projects/app)", r.status === 0 && /^BUILD\s+PIPELINE\s+STATE/m.test(r.stdout) && /#1\s+p\s+failed\s+projects\/app\s+main/.test(r.stdout) && /#2\s+p\s+running/.test(r.stdout), said(r));
  r = await pando(["ci", "build", "list", "--state", "failed", "--branch", "main", "--json", "--monorepo", full]);
  check("--state and --branch narrow it (outside the folder, with --monorepo)", parsed(r)?.builds?.length === 1 && parsed(r).builds[0].id === build1, said(r));
  r = await pando(["ci", "build", "view", "1"], { cwd: mono });
  check("pando ci build view 1 (the monorepo's one pipeline): its jobs, states and checks", r.status === 0 && /^p #1\s+failed/m.test(r.stdout) && /ci\s+failed\s+ci\s+1\s+1m0s\s+job-ci-1/.test(r.stdout) && /lint\s+passed\s+lint\s+0/.test(r.stdout), said(r));
  r = await pando(["ci", "build", "view", "p/1", "--json"], { cwd: mono });
  j = parsed(r);
  check("view p/1 --json: getCiBuild's answer, with jobs", j?.id === build1 && j.number === 1 && j.jobs?.length === 2, said(r));
  r = await pando(["ci", "build", "view", "7"], { cwd: mono });
  check("a build that is not there: one plain line, exit 1", r.status === 1 && /has no build p #7/.test(r.stderr) && r.stderr.trim().split("\n").length === 1, said(r));

  bk.logs["job-ci-1"] = "\x1b_bk;t=1700000000000\x07FAIL one test\n\x1b_bk;t=1700000000001\x07\x1b[31mred\x1b[0m line\n";
  r = await pando(["ci", "build", "log", "1", "--job", "ci"], { cwd: mono });
  check("pando ci build log 1 --job ci: the log, Buildkite's timestamps and (in a pipe) colours taken out", r.status === 0 && r.stdout === "FAIL one test\nred line\n", JSON.stringify(r.stdout));
  r = await pando(["ci", "build", "log", build1, "--json"], { cwd: mono });
  j = parsed(r);
  check("log --json: an array of getCiJobLog answers, one per job", Array.isArray(j) && j.length === 2 && j.some((x) => x.job === "job-ci-1" && x.content.includes("FAIL one test")), said(r));

  // --follow: the log as it grows, until the job has finished and its log was read after that (a running job's copy is kept 10 s).
  bk.logs["job-e2e-2"] = "step 1\n";
  await send("job.started", { ...b2("running", { started_at: iso(6000) }), job: bkJob("job-e2e-2", "e2e", { state: "running", created_at: iso(5500), started_at: iso(6000) }) });
  const following = pando(["ci", "build", "log", "2", "--job", "e2e", "--follow"], { cwd: mono });
  await new Promise((res) => setTimeout(res, 3000));
  bk.logs["job-e2e-2"] = "step 1\nstep 2\n";
  await send("job.finished", { ...b2("running", { started_at: iso(6000) }), job: bkJob("job-e2e-2", "e2e", { state: "passed", exit_status: 0, created_at: iso(5500), started_at: iso(6000), finished_at: new Date().toISOString() }) });
  r = await following;
  check("pando ci build log --follow prints the log as it grows, each line once, and stops when the job has finished", r.status === 0 && r.stdout === "step 1\nstep 2\n" && /e2e passed/.test(r.stderr), said(r));
  r = await pando(["ci", "build", "list", "--limit", "1", "--json"], { cwd: mono });
  check("--limit 1: one build, and the cursor to the rest", parsed(r)?.builds?.length === 1 && !!parsed(r).next_cursor, said(r));

  r = await pando(["ci", "build", "cancel", "2"], { cwd: mono });
  check("pando ci build cancel 2: passed to Buildkite", r.status === 0 && /Canceling p #2/.test(r.stdout) && bk.calls.includes("PUT /v2/organizations/o/pipelines/p/builds/2/cancel"), said(r));
  r = await pando(["ci", "job", "retry", "1", "ci"], { cwd: mono });
  check("pando ci job retry 1 ci: passed to Buildkite, the new job named", r.status === 0 && /Retrying ci in p #1: new job job-ci-1-retry/.test(r.stdout), said(r));
  r = await pando(["ci", "build", "rebuild", "1", "--json"], { cwd: mono });
  j = parsed(r);
  check("pando ci build rebuild 1 --json: a new build of the same commit", r.status === 0 && j?.build?.number === 100 && j.build.sha === mainSha && j.build.rebuilt_from === "bld-p-1", said(r));
  r = await pando(["ci", "run", "p", "--branch", "feat-a"], { cwd: mono });
  check("pando ci run p --branch feat-a: New build of the branch's head", r.status === 0 && /Started p #101 of feat-a at [0-9a-f]{7}/.test(r.stdout), said(r));
  r = await pando(["ci", "run", "nope"], { cwd: mono });
  check("ci run of a pipeline that is not there: exit 1, the API's code", r.status === 1 && /\(not_found, HTTP 404\)/.test(r.stderr), said(r));
  check("every call to the stand-in carried BUILDKITE_API_TOKEN", bk.calls.length > 0 && bk.badAuth === 0, `${bk.calls.length} calls`);

  // ── pando branch view, pando hook, pando machine list ──
  r = await pando(["branch", "view", "feat-a"], { cwd: app });
  check("pando branch view feat-a: state, title, head, checks, reviews", r.status === 0 && /^feat-a\s+open\s+in projects\/app/m.test(r.stdout) && /A title/.test(r.stdout) && /head\s+[0-9a-f]{7}/.test(r.stdout) && /reviews\s+none/.test(r.stdout), said(r));
  await pando(["review", "feat-a", "-m", "Reads well."], { cwd: app });
  r = await pando(["branch", "view", "feat-a", "--json", "--commits"], { cwd: app });
  j = parsed(r);
  check("branch view --json: {branch, reviews, commits} as the API gives them", j?.branch?.name === "feat-a" && j.reviews?.[0]?.body === "Reads well." && Array.isArray(j.commits?.commits), said(r));
  r = await pando(["hook", "list", "--json"], { cwd: app });
  j = parsed(r);
  check("pando hook list --json: the web hook and the buildkite hook", j?.hooks?.some((h) => h.id === webHook && h.type === "web") && j.hooks.some((h) => h.type === "buildkite"), said(r));
  const secretFile = join(work, "hook-secret");
  writeFileSync(secretFile, "another-secret\n", { mode: 0o600 });
  r = await pando(["hook", "create", `http://127.0.0.1:${port}/two`, "--event", "merged", "--secret-file", secretFile], { cwd: app });
  const second = /Added hook (hk_[0-9a-f]+)/.exec(r.stdout)?.[1];
  check("pando hook create with --secret-file (the secret never on the command line)", r.status === 0 && !!second && /gets merged/.test(r.stdout) && !r.stdout.includes("another-secret"), said(r));
  r = await pando(["hook", "create", `http://127.0.0.1:${port}/two`, "--secret-file", secretFile], { cwd: app });
  const hooksNow = (await call("GET", `/v1/monorepos/${full}/repos/projects-app/hooks`, S)).json?.hooks ?? [];
  check("the same create again (a retry) adds nothing", r.status === 0 && /already has hook/.test(r.stdout) && hooksNow.filter((h) => h.url === `http://127.0.0.1:${port}/two`).length === 1, said(r));
  r = await pando(["hook", "create", `http://127.0.0.1:${port}/three`], { cwd: app });
  check("no secret, not a terminal: refused, nothing made", r.status === 1 && /--secret-file/.test(r.stderr), said(r));
  r = await pando(["hook", "deliveries", webHook, "--json"], { cwd: app });
  check("pando hook deliveries --json", r.status === 0 && Array.isArray(parsed(r)?.deliveries), said(r));
  r = await pando(["hook", "delete", second], { cwd: app });
  check("pando hook delete", r.status === 0 && !((await call("GET", `/v1/monorepos/${full}/repos/projects-app/hooks`, S)).json?.hooks ?? []).some((h) => h.id === second), said(r));
  r = await pando(["machine", "list", "--json"], { cwd: mono });
  check("pando machine list --json: this machine's credential", r.status === 0 && parsed(r)?.machines?.some((m) => m.name === "cli-box" && m.login === LOGIN), said(r));

  // ── pando members invites and revoke ──
  const email = `ana-${id}@example.com`;
  r = await pando(["members", "invite", email], { cwd: mono });
  check("pando members invite", r.status === 0 && r.stdout.includes(`Invited ${email}`), said(r));
  r = await pando(["members", "invites", "--json"], { cwd: mono });
  check("pando members invites --json: the waiting invite", parsed(r)?.invites?.some((i) => i.email === email && i.invited_by === LOGIN), said(r));
  r = await pando(["members", "invites"], { cwd: mono });
  check("pando members invites: a line for it", r.status === 0 && r.stdout.includes(email), said(r));
  r = await pando(["members", "revoke", email], { cwd: mono });
  check("pando members revoke <email>", r.status === 0 && r.stdout.includes(`Withdrew the invite for ${email}`), said(r));
  r = await pando(["members", "invites"], { cwd: mono });
  check("then no invite waits", r.status === 0 && /No invites are waiting/.test(r.stdout), said(r));
  r = await pando(["members", "revoke", LOGIN], { cwd: mono });
  check("revoke takes an email only (remove takes a login)", r.status === 2, said(r));

  // ── pando monorepo rename, then by the new name ──
  r = await pando(["monorepo", "rename", RENAMED], { cwd: mono });
  const renamed = `${LOGIN}/${RENAMED}`;
  check("pando monorepo rename (in its folder): renamed, the folder follows", r.status === 0 && r.stdout.includes(`Renamed ${full} to ${renamed}`) && /This folder now uses/.test(r.stdout), said(r));
  full = renamed;
  r = await pando(["monorepo", "rename", RENAMED], { cwd: mono });
  check("the same rename again (a retry): nothing to do, exit 0", r.status === 0 && /already has that name/.test(r.stdout), said(r));
  r = await pando(["api", "/monorepos/{owner}/{monorepo}"], { cwd: app });
  check("{owner}/{monorepo} from the folder is now the new name", parsed(r)?.full_name === renamed, said(r));
  r = await pando(["monorepo", "view", renamed, "--json"]);
  j = parsed(r);
  check("pando monorepo view <new name> --json: {monorepo, repos, members}", j?.monorepo?.full_name === renamed && j.repos?.[0]?.path === "projects/app" && j.members?.[0]?.login === LOGIN, said(r));
  r = await pando(["monorepo", "view", renamed]);
  check("pando monorepo view: kind, role, repos with main's head", r.status === 0 && r.stdout.startsWith(`${renamed}  monorepo  (you are owner)`) && new RegExp(`projects/app\\s+${mainSha.slice(0, 7)}`).test(r.stdout), said(r));
  r = await pando(["api", `/monorepos/${LOGIN}/${NAME}`]);
  check("the old name still leads to it", parsed(r)?.full_name === renamed, said(r));
  const remote = git(["remote", "get-url", "pando"], app).stdout.trim();
  check("the checkout pando init pushed from points at the new clone URL", remote.endsWith(`/${LOGIN}/${RENAMED}/projects-app.git`), remote);
  r = await pando(["branch", "list", "--json"], { cwd: app });
  check("commands in the folder work under the new name", r.status === 0 && r.stdout.includes("feat-a"), said(r));

  // ── pando activity ──
  const lines = await waitFor(async () => {
    const a = await pando(["activity", "--json", "--limit", "50"], { cwd: mono });
    const ev = parsed(a)?.events ?? [];

    return ev.some((e) => e.kind === "push") && ev.some((e) => e.kind === "branch.opened" && e.branch === "feat-a") ? ev : null;
  });

  check("pando activity --json: this monorepo's lines (the push of main, feat-a opened), under its new name", !!lines && lines.every((e) => e.monorepo === renamed), lines ? `${lines.length} lines` : "none in 30 s");
  r = await pando(["activity", "--limit", "3"], { cwd: mono });
  check("pando activity: one line each, at most --limit", r.status === 0 && r.stdout.trim().split("\n").length <= 3 && new RegExp(LOGIN).test(r.stdout), said(r));
  r = await pando(["activity", "--all", "--json", "--limit", "5"], { cwd: mono });
  check("--all: every monorepo's lines, this one's among them", r.status === 0 && (parsed(r)?.events ?? []).some((e) => e.monorepo === renamed), said(r));

  // The help: the new commands, no agent name, never "meta layer".
  r = await pando(["help"]);
  const help = r.stderr;
  check("pando help lists the new commands", ["pando api <path>", "pando ci build list", "pando ci job retry", "pando ci run <pipeline>", "pando branch view", "pando monorepo rename", "pando members invites", "pando hook list", "pando machine list", "pando activity"].every((x) => help.includes(x)));
  check("... and never says meta layer or agent", !/meta layer|agent/i.test(help));
} catch (cause) {
  check("no exception", false, describeError(cause));
} finally {
  if (full) {
    const r = await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, S);
    check(`delete ${full}`, r.status === 204, String(r.status));
  }

  server.close();
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
