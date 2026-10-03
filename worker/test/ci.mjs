// CI, end to end against `wrangler dev` (worker/src/ci/):
//   1. the status token: minted per hook delivery, verified on the statuses
//      route, `app` stamped, scoped to one commit in one repo for 24 hours;
//      `pando status` (the cli) posts with it;
//   2. the Buildkite integration: webhooks in, builds and jobs and checks
//      stored, the read API, details and actions against a local stand-in for
//      Buildkite's REST API (there is no real Buildkite yet).
//
//   PANDO_URL=http://localhost:8794 node test/ci.mjs
//
// Reads PANDO_BOOTSTRAP and PANDO_STATUS_SECRET from worker/.dev.vars (to
// make users, and to mint expired and forged tokens). Credentials and tokens
// are never printed.
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeError, retryResetFetch } from "./errors.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8794").replace(/\/$/, "");
const VARS = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(VARS)?.[1];
const STATUS_SECRET = /^PANDO_STATUS_SECRET=(.*)$/m.exec(VARS)?.[1];
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
const call = async (method, path, secret, body, headers = {}) => {
  const res = await fetch(URL_ + path, {
    method,
    redirect: "manual",
    headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
};
const waitFor = async (pred, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** A status token made here, as the Worker makes them (to test expiry and forgery). */
const mint = (secret, claims) => {
  const signed = "pst1." + b64url(JSON.stringify(claims));
  return `${signed}.${b64url(createHmac("sha256", secret).update(signed).digest())}`;
};
const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

// ── the receivers: Buildkite's create-build, two web hooks, and a stand-in for Buildkite's REST API ──
const got = { buildkite: [], web: [] };
/** The stand-in's state: what it was asked, and what it answers. */
const bkStub = { calls: [], badAuth: 0, logs: {}, annotations: [], artifacts: [], pipelineYaml: "steps:\n  - key: ci\n    command: npm test\n", rateLimited: false, nextNumber: 100, created: [] };
const bkApi = (req, raw, res) => {
  const u = new URL(req.url, "http://x");
  bkStub.calls.push(`${req.method} ${u.pathname}`);
  // The Worker sends BUILDKITE_API_TOKEN as a Bearer, here and to Buildkite only (never printed).
  if (req.headers.authorization !== `Bearer ${BK_TOKEN}`) bkStub.badAuth++;
  if (bkStub.rateLimited) return res.writeHead(429, { "ratelimit-remaining": "0", "ratelimit-reset": "30", "content-type": "application/json" }).end('{"message":"slow down"}');
  const json = (code, v, h = {}) => res.writeHead(code, { "content-type": "application/json", "ratelimit-remaining": "40", "ratelimit-reset": "20", ...h }).end(JSON.stringify(v));
  let m;
  if ((m = /^\/v2\/organizations\/o\/pipelines\/([^/]+)\/builds$/.exec(u.pathname)) && req.method === "POST") {
    const body = JSON.parse(raw);
    bkStub.created.push(body);
    const n = bkStub.nextNumber++;
    return json(201, { ...bkBuild(m[1], n, { state: "scheduled", commit: body.commit, branch: body.branch, message: body.message, meta_data: body.meta_data }), pipeline: bkPipeline(m[1]) });
  }
  if ((m = /^\/v2\/organizations\/o\/pipelines\/([^/]+)\/builds\/(\d+)\/cancel$/.exec(u.pathname)) && req.method === "PUT") {
    return json(200, { ...bkBuild(m[1], Number(m[2]), { state: "canceling", ...(bkStub.builds?.[m[2]] ?? {}) }), pipeline: bkPipeline(m[1]) });
  }
  if ((m = /^\/v2\/organizations\/o\/pipelines\/([^/]+)\/builds\/(\d+)\/jobs\/([^/]+)\/retry$/.exec(u.pathname)) && req.method === "PUT") {
    return json(200, bkJob(`${m[3]}-retry`, "ci", { state: "scheduled", created_at: new Date(Date.now() + 1000).toISOString() }));
  }
  if ((m = /^\/v2\/organizations\/o\/pipelines\/([^/]+)\/builds\/(\d+)\/jobs\/([^/]+)\/log$/.exec(u.pathname))) {
    if (req.headers.accept !== "text/plain") return json(406, { message: "ask for text/plain" });
    return res.writeHead(200, { "content-type": "text/plain" }).end(bkStub.logs[m[3]] ?? "no log\n");
  }
  if (/\/builds\/\d+\/annotations$/.test(u.pathname)) return json(200, bkStub.annotations);
  if ((m = /\/builds\/\d+\/jobs\/([^/]+)\/artifacts\/([^/]+)\/download$/.exec(u.pathname))) {
    return res.writeHead(302, { location: `https://artifacts.example/signed/${m[2]}?expires=60` }).end();
  }
  if (/\/builds\/\d+\/artifacts$/.test(u.pathname)) return json(200, bkStub.artifacts);
  if ((m = /^\/v2\/organizations\/o\/pipelines\/([^/]+)$/.exec(u.pathname))) return json(200, { ...bkPipeline(m[1]), configuration: bkStub.pipelineYaml });
  json(404, { message: "Not Found" });
};
/** Buildkite's objects, as its REST API and webhooks shape them (docs read 2026-10-03). */
const bkPipeline = (slug, org = "o") => ({
  id: `pl-${slug}`, url: `https://api.buildkite.com/v2/organizations/${org}/pipelines/${slug}`, web_url: `https://buildkite.com/${org}/${slug}`,
  name: slug, slug, repository: "https://example.invalid/repo.git", default_branch: "main", visibility: "private",
});
const bkBuild = (slug, n, o = {}, org = "o") => ({
  id: o.id ?? `bld-${slug}-${n}`, graphql_id: "x", url: `https://api.buildkite.com/v2/organizations/${org}/pipelines/${slug}/builds/${n}`,
  web_url: `https://buildkite.com/${org}/${slug}/builds/${n}`, number: n, state: o.state ?? "scheduled", blocked: false, message: o.message ?? "a build",
  commit: o.commit ?? "HEAD", branch: o.branch ?? "main", env: o.env ?? {}, source: "api", creator: null, meta_data: o.meta_data ?? {},
  created_at: o.created_at ?? new Date().toISOString(), scheduled_at: o.created_at ?? new Date().toISOString(),
  started_at: o.started_at ?? null, finished_at: o.finished_at ?? null,
});
const bkJob = (id, key, o = {}) => ({
  id, graphql_id: "x", type: o.type ?? "script", name: o.name ?? key, step_key: key, state: o.state ?? "scheduled",
  web_url: `https://buildkite.com/o/p/builds/1#${id}`, log_url: "x", raw_log_url: "x", command: "npm test",
  soft_failed: o.soft_failed ?? false, exit_status: o.exit_status ?? null, created_at: o.created_at ?? new Date().toISOString(),
  started_at: o.started_at ?? null, finished_at: o.finished_at ?? null, retried: o.retried ?? false,
});
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url.startsWith("/v2/")) return bkApi(req, raw, res);
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {}
    if (req.url === "/buildkite") {
      got.buildkite.push(body);
      return res.writeHead(201, { "content-type": "application/json" }).end("{}");
    }
    got.web.push({ route: req.url, body });
    res.writeHead(200).end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const id = Date.now().toString(36);
const work = mkdtempSync(join(tmpdir(), "pando-ci-"));
const M = `ci-${id}`;
const M2 = `ci2-${id}`;
let O = null;
let S = null;
const made = [];
try {
  if (!STATUS_SECRET) throw new Error("worker/.dev.vars has no PANDO_STATUS_SECRET");
  S = (await call("POST", "/v1/users", BOOT, { login: `ci-${id}` })).json?.credential?.secret;
  let r = await call("POST", "/v1/monorepos", S, { name: M, kind: "repo" });
  O = r.json?.monorepo?.owner ?? null;
  const MID = r.json?.monorepo?.id;
  if (r.status === 201) made.push(M);
  const url = r.json?.repos?.[0]?.clone_url;
  const base = `/v1/monorepos/${O}/${M}/repos/${M}`;
  r = await call("POST", "/v1/monorepos", S, { name: M2, kind: "repo" });
  if (r.status === 201) made.push(M2);
  check("two plain repos made", made.length === 2 && MID);

  // ── 1. The status token ──
  const hook = async (body) => await call("POST", `${base}/hooks`, S, body);
  const bk = (await hook({ type: "buildkite", buildkite: { organization: "o", pipeline: "p", api_url: `http://127.0.0.1:${port}/buildkite` } })).json;
  const gha = (await hook({ type: "web", url: `http://127.0.0.1:${port}/gha`, secret: "s", events: ["push"], app: "github-actions" })).json;
  const plainWeb = (await hook({ type: "web", url: `http://127.0.0.1:${port}/plain`, secret: "s", events: ["push"] })).json;
  check("hooks registered: buildkite, a web hook with app github-actions, a web hook with none", bk?.app === "buildkite" && gha?.app === "github-actions" && plainWeb?.id && plainWeb.app === null);
  r = await hook({ type: "web", url: `http://127.0.0.1:${port}/x`, secret: "s", app: "buildkite" });
  check("a web hook cannot claim app buildkite", r.status === 400);
  r = await hook({ type: "web", url: `http://127.0.0.1:${port}/x`, secret: "s", app: "Not A Slug" });
  check("a web hook's app must be a slug", r.status === 400);

  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" };
  const git = (a, cwd) => spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...a], { cwd, env, encoding: "utf8" });
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "f"), "x\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  git(["push", "-q", url, "main"], src);
  const mainSha = git(["rev-parse", "HEAD"], src).stdout.trim();
  git(["checkout", "-qb", "feat"], src);
  writeFileSync(join(src, "g"), "y\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "feat"], src);
  check("push main and a branch", git(["push", "-q", url, "feat"], src).status === 0);
  const head = git(["rev-parse", "HEAD"], src).stdout.trim();

  const build = await waitFor(() => got.buildkite.find((b) => b?.commit === head));
  const benv = build?.env ?? {};
  const token = benv.PANDO_STATUS_TOKEN;
  check("the Buildkite build gets PANDO_STATUS_TOKEN beside PANDO_READ_TOKEN", /^pst1\./.test(token ?? "") && /^art_v\d+_/.test(benv.PANDO_READ_TOKEN ?? ""));
  const c = token ? claimsOf(token) : {};
  check("its claims: this monorepo's id, this repo, this commit, app buildkite, the hook, 24 hours", c.m === MID && c.r === M && c.s === head && c.a === "buildkite" && c.h === bk?.id && Math.abs(c.x - (Date.now() / 1000 + 86400)) < 120);
  const readExp = Number(/\?expires=(\d+)/.exec(benv.PANDO_READ_TOKEN ?? "")?.[1]);
  check("the build's read token lives at least 24 hours (Retry in Buildkite can still clone)", readExp * 1000 - Date.now() > 24 * 3600_000 - 120_000, readExp ? `${Math.round((readExp * 1000 - Date.now()) / 3600_000)} h` : "no expiry in the token");
  check("meta_data maps the build back: pando_delivery, pando_monorepo, pando_repo", build?.meta_data?.pando_delivery && build.meta_data.pando_monorepo === MID && build.meta_data.pando_repo === M);
  const ghaGot = await waitFor(() => got.web.find((w) => w.route === "/gha" && w.body?.head === head));
  const plainGot = await waitFor(() => got.web.find((w) => w.route === "/plain" && w.body?.head === head));
  check("a web hook's payload carries status_token", /^pst1\./.test(ghaGot?.body?.status_token ?? "") && !!ghaGot.body.status_token_expires_at);
  const webRead = Number(/\?expires=(\d+)/.exec(ghaGot?.body?.read_token ?? "")?.[1]);
  check("a web hook's read token still lives 30 minutes", webRead * 1000 - Date.now() <= 31 * 60_000);

  const statusPath = `${base}/statuses/${head}`;
  r = await call("POST", statusPath, token, { state: "pending", context: "ci", target_url: "https://buildkite.example/b/1" });
  check("a status token posts a status: 201, app buildkite, creator app:buildkite", r.status === 201 && r.json?.app === "buildkite" && r.json?.creator === "app:buildkite", `${r.status} ${r.json?.app} ${r.json?.creator}`);
  r = await call("POST", statusPath, token, { state: "success", context: "ci", app: "something-else" });
  check("the body cannot change the app", r.status === 201 && r.json?.app === "buildkite");
  r = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/commits/${head}/status`, S);
  const ciStatus = r.json?.statuses?.find((s) => s.context === "ci");
  check("the combined status carries app", ciStatus?.state === "success" && ciStatus.app === "buildkite");
  r = await call("POST", statusPath, S, { state: "success", context: "manual", app: "buildkite" });
  check("a member's own credential: app null, creator the member, whatever the body says", r.status === 201 && r.json?.app === null && r.json?.creator === `ci-${id}`, `${r.json?.app} ${r.json?.creator}`);
  const ev = (await call("GET", `/v1/monorepos/${O}/${M}/events?since=0&limit=500`, S)).json?.events ?? [];
  const sev = ev.filter((e) => e.kind === "status" && e.row?.sha === head);
  check("events: an app's status has app and no actor; a member's has the member", sev.some((e) => e.row.app === "buildkite" && e.actor === null) && sev.some((e) => e.row.app === null && e.actor === `ci-${id}`));

  r = await call("POST", `${base}/statuses/${mainSha}`, token, { state: "success" });
  check("the wrong sha: 403 status_token_scope", r.status === 403 && r.json?.error?.code === "status_token_scope");
  r = await call("POST", `/v1/monorepos/${O}/${M}/repos/other/statuses/${head}`, token, { state: "success" });
  check("the wrong repo: 403 status_token_scope", r.status === 403 && r.json?.error?.code === "status_token_scope");
  r = await call("POST", `/v1/monorepos/${O}/${M2}/repos/${M2}/statuses/${head}`, token, { state: "success" });
  check("another monorepo: 403 status_token_scope", r.status === 403 && r.json?.error?.code === "status_token_scope");
  r = await call("GET", `${base}/branches`, token);
  check("any other route: 403 status_token_route", r.status === 403 && r.json?.error?.code === "status_token_route");
  r = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/commits/${head}/status`, token);
  check("even reading the status it posted: 403", r.status === 403);
  const gitRes = await fetch(`${url}/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${token}` } });
  await gitRes.body?.cancel();
  check("no git: the git door answers 401", gitRes.status === 401, String(gitRes.status));
  r = await call("GET", "/v1/user", token);
  check("not a user credential: 401", r.status === 401);

  const now = Math.floor(Date.now() / 1000);
  r = await call("POST", statusPath, mint(STATUS_SECRET, { ...c, x: now - 1 }), { state: "success" });
  check("expired: 401 status_token_expired", r.status === 401 && r.json?.error?.code === "status_token_expired");
  r = await call("POST", statusPath, mint("not-the-secret", c), { state: "success" });
  check("signed with another secret: 401", r.status === 401 && r.json?.error?.code === "unauthorized");
  const plainToken = plainGot?.body?.status_token;
  const pc = plainToken ? claimsOf(plainToken) : {};
  const forged = `pst1.${b64url(JSON.stringify({ ...pc, a: "buildkite" }))}.${plainToken?.split(".")[2]}`;
  r = await call("POST", statusPath, forged, { state: "success", context: "forged" });
  check("a forged app (payload changed, signature kept): 401", r.status === 401);
  r = await call("POST", statusPath, plainToken, { state: "success", context: "plain-web" });
  check("a web hook with no app: app null, creator hook:<id>", r.status === 201 && r.json?.app === null && r.json?.creator === `hook:${plainWeb.id}`);
  r = await call("POST", statusPath, ghaGot?.body?.status_token, { state: "failure", context: "gha" });
  check("a web hook with app github-actions stamps it", r.status === 201 && r.json?.app === "github-actions");

  const line = await waitFor(async () => {
    const page = (await call("GET", `/v1/events?limit=100`, S)).json?.events ?? [];
    return page.find((e) => e.kind === "status" && e.summary?.context === "gha" && e.summary?.app === "github-actions");
  }, 30_000);
  check("the home's activity line for a status carries app", !!line && line.actor === null);

  // `pando status`, the cli, in a CI step: PANDO_STATUS_URL and PANDO_STATUS_TOKEN from the build's env.
  const cli = fileURLToPath(new URL("../../cli", import.meta.url));
  const bin = join(work, "pando");
  const built = spawnSync("go", ["build", "-o", bin, "./cmd/pando"], { cwd: cli, encoding: "utf8" });
  check("the cli builds", built.status === 0, built.stderr?.slice(0, 200));
  const ciEnv = { ...process.env, PANDO_HOME: join(work, "pando-home"), PANDO_STATUS_URL: benv.PANDO_STATUS_URL, PANDO_STATUS_TOKEN: token, BUILDKITE_BUILD_URL: "https://buildkite.example/b/2" };
  const step = spawnSync(bin, ["status", "failure", "--context", "e2e", "--description", "3 failed"], { cwd: src, env: ciEnv, encoding: "utf8" });
  check("pando status failure --context e2e, from the build's env", step.status === 0 && /e2e: failure on [0-9a-f]{7} \(reported as buildkite\)/.test(step.stdout), scrub(step.stdout + step.stderr).trim());
  check("pando status never prints the token", !(step.stdout + step.stderr).includes(token ?? "pst1."));
  r = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/commits/${head}/status`, S);
  const e2e = r.json?.statuses?.find((s) => s.context === "e2e");
  check("its check: e2e failure, app buildkite, the build's link", e2e?.state === "failure" && e2e.app === "buildkite" && e2e.target_url === "https://buildkite.example/b/2" && e2e.description === "3 failed");
  const bare = spawnSync(bin, ["status", "success"], { cwd: src, env: { ...ciEnv, PANDO_STATUS_TOKEN: "" }, encoding: "utf8" });
  check("without the token it says what is missing", bare.status !== 0 && /PANDO_STATUS_TOKEN/.test(bare.stderr));
  const help = spawnSync(bin, ["help"], { encoding: "utf8" });
  check("the help shows both forms of pando status", /pando status\s+this folder/.test(help.stderr) && /pando status <pending\|success\|failure\|error>/.test(help.stderr));

  // ── 2. Buildkite ──
  const ciBase = `/v1/monorepos/${O}/${M}/ci`;
  const B = (await call("POST", "/v1/users", BOOT, { login: `cib-${id}` })).json?.credential?.secret;
  r = await call("PUT", `/v1/monorepos/${O}/${M}/members/cib-${id}`, S, { role: "member" });
  check("a second person joins as a member", r.status === 200);

  r = await call("POST", `${ciBase}/connections`, B, { service: "buildkite", organization: "o" });
  check("a member cannot connect a CI service", r.status === 403);
  r = await call("POST", `${ciBase}/connections`, S, { service: "buildkite", organization: "o", api_url: "https://api.example.com" });
  check("api_url points only at this machine (tests)", r.status === 400);
  r = await call("POST", `${ciBase}/connections`, S, { service: "buildkite", organization: "O", api_url: `http://127.0.0.1:${port}` });
  const conn = r.json?.connection;
  const WH = r.json?.webhook_token;
  check("an owner connects Buildkite: the webhook URL, and its token shown once", r.status === 201 && conn?.organization === "o" && conn.webhook_url === `${URL_}/v1/integrations/buildkite/${conn.id}` && typeof WH === "string" && WH.length >= 32 && conn.token === "worker_secret");
  r = await call("POST", `${ciBase}/connections`, S, { service: "buildkite", organization: "o" });
  check("the same organization twice: 409", r.status === 409);
  r = await call("GET", ciBase, B);
  const plP = r.json?.pipelines?.find((x) => x.slug === "p");
  check("GET /ci: the service, the connection with no event yet, pipeline p from the buildkite hook, required checks per repo",
    r.status === 200 && r.json.services?.[0]?.service === "buildkite" && r.json.connections?.[0]?.last_event === null && plP?.repo === M && plP.hook_id === bk?.id && plP.last_build === null && r.json.required_checks?.[0]?.repo === M);

  const hookUrl = `/v1/integrations/buildkite/${conn.id}`;
  const send = async (event, payload, o = {}) => {
    const body = JSON.stringify({ event, ...payload });
    const ts = Math.floor(Date.now() / 1000) + (o.skew ?? 0);
    const headers = { "x-buildkite-event": event };
    if (o.token) headers["x-buildkite-token"] = o.token === true ? WH : o.token;
    else headers["x-buildkite-signature"] = `timestamp=${ts},signature=${createHmac("sha256", o.key ?? WH).update(`${ts}.${body}`).digest("hex")}`;
    return call("POST", hookUrl, null, body, headers);
  };
  r = await call("POST", hookUrl, null, "{}", { "x-buildkite-event": "ping" });
  check("a webhook with no token or signature: 401", r.status === 401);
  r = await send("ping", {}, { token: "wrong-token-wrong-token" });
  check("the wrong token: 401", r.status === 401);
  r = await send("ping", {}, { key: "not-the-token" });
  check("a signature with another key: 401", r.status === 401);
  r = await send("ping", {}, { skew: -600 });
  check("a signature over 5 minutes old (a replay): 401", r.status === 401);
  r = await call("POST", "/v1/integrations/buildkite/m_0000000000000000--cic_000000000000", null, "{}", { "x-buildkite-event": "ping", "x-buildkite-token": WH });
  check("an unknown monorepo or connection: 404", r.status === 404);
  r = await send("ping", {}, { token: true });
  check("ping with X-Buildkite-Token: recorded", r.status === 200 && r.json?.result === "recorded");
  r = await call("GET", ciBase, S);
  check("the CI tab shows the last event and the last refusal", r.json?.connections?.[0]?.last_event?.event === "ping" && !!r.json.connections[0].last_refused?.reason);

  // A build Pando started: a new commit on feat goes to the buildkite hook.
  writeFileSync(join(src, "h"), "z\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "second"], src);
  git(["push", "-q", url, "feat"], src);
  const head2 = git(["rev-parse", "HEAD"], src).stdout.trim();
  const started = await waitFor(() => got.buildkite.find((b) => b?.commit === head2));
  const md = started?.meta_data ?? {};
  const t0 = Date.now();
  const iso = (ms) => new Date(t0 + ms).toISOString();
  const B1 = (state, o = {}) => ({ build: bkBuild("p", 1, { state, commit: head2, branch: "feat", message: "second", meta_data: md, created_at: iso(0), ...o }), pipeline: bkPipeline("p") });
  const JOB1 = (jid, key, state, o = {}) => ({ ...B1(o.buildState ?? "running", { started_at: iso(1000) }), job: bkJob(jid, key, { state, created_at: iso(500), ...o }) });
  r = await send("build.scheduled", B1("scheduled"));
  const build1 = r.json?.build;
  check("build.scheduled for a build Pando started: recorded", r.status === 200 && r.json?.result === "recorded" && /^cib_/.test(build1 ?? ""), JSON.stringify(r.json));
  r = await call("GET", `${ciBase}/builds`, B);
  const row1 = r.json?.builds?.find((b) => b.id === build1);
  check("the build: repo, commit, branch, number, queued, who pushed (from Pando's delivery)",
    row1?.repo === M && row1.sha === head2 && row1.branch === "feat" && row1.number === 1 && row1.state === "queued" && row1.pushed_by === `ci-${id}` && row1.pipeline === "p" && row1.service === "buildkite");
  const statusOf = async (ctx) => (await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/commits/${head2}/status`, S)).json?.statuses?.find((x) => x.context === ctx);
  await send("job.scheduled", JOB1("job-ci-1", "ci", "scheduled", { buildState: "scheduled" }));
  let st = await statusOf("ci");
  check("the job keyed ci is the check ci: pending, app buildkite, creator app:buildkite, the job's link", st?.state === "pending" && st.app === "buildkite" && st.creator === "app:buildkite" && st.target_url?.endsWith("#job-ci-1"));
  await send("job.started", JOB1("job-ci-1", "ci", "running", { started_at: iso(1000) }));
  await send("job.scheduled", JOB1("job-tc-1", "typecheck", "scheduled"));
  await send("job.finished", JOB1("job-tc-1", "typecheck", "passed", { exit_status: 0, started_at: iso(1000), finished_at: iso(24000) }));
  await send("job.scheduled", JOB1("job-wait", null, "scheduled", { type: "waiter" }));
  await send("job.finished", JOB1("job-ci-1", "ci", "failed", { exit_status: 1, started_at: iso(1000), finished_at: iso(73000) }));
  await send("build.finished", B1("failed", { started_at: iso(1000), finished_at: iso(75000) }));
  st = await statusOf("ci");
  check("the job fails: ci failure, '#1 failed, exit status 1'", st?.state === "failure" && st.description === "#1 failed, exit status 1", st?.description);
  check("typecheck passed: '#1 passed in 23 s'", (await statusOf("typecheck"))?.description === "#1 passed in 23 s");
  r = await call("GET", `${ciBase}/builds/${build1}`, B);
  let jobs = r.json?.jobs ?? [];
  check("the build and its jobs: failed in 74 s; ci failed with exit status 1 as check ci; typecheck passed; no wait step",
    r.json?.state === "failed" && r.json.duration_s === 74 && jobs.length === 2 && jobs.find((j) => j.id === "job-ci-1")?.exit_status === 1 && jobs.find((j) => j.id === "job-ci-1")?.check === "ci" && jobs.find((j) => j.id === "job-tc-1")?.state === "passed");
  await send("job.started", JOB1("job-ci-1", "ci", "running", { started_at: iso(1000) }));
  await send("build.running", B1("running", { started_at: iso(1000) }), { skew: -60 });
  r = await call("GET", `${ciBase}/builds/${build1}`, B);
  check("late events never move a finished build or job back", r.json?.state === "failed" && r.json.jobs.find((j) => j.id === "job-ci-1")?.state === "failed" && (await statusOf("ci"))?.state === "failure");
  const evs = (await call("GET", `/v1/monorepos/${O}/${M}/events?since=0&limit=500&topics=repo:${M}`, S)).json?.events ?? [];
  check("ci.build and ci.job events on the monorepo's stream, on the repo's topic",
    evs.some((e) => e.kind === "ci.build" && e.collection === "ci_builds" && e.key === build1 && e.row?.state === "failed") && evs.some((e) => e.kind === "ci.job" && e.key === `${build1}/job-ci-1`));

  // Retry, passed through: the new job is recorded at once and the check goes back to pending.
  r = await call("POST", `${ciBase}/builds/${build1}/jobs/job-ci-1/retry`, B);
  check("Retry a failed job (any member): passed to Buildkite, the new job recorded", r.status === 202 && r.json?.job?.id === "job-ci-1-retry" && bkStub.calls.includes("PUT /v2/organizations/o/pipelines/p/builds/1/jobs/job-ci-1/retry"));
  st = await statusOf("ci");
  check("after Retry the check ci is pending again (the newest job keyed ci reports)", st?.state === "pending" && st.description === "#1 queued", st?.description);
  await send("job.finished", JOB1("job-ci-1", "ci", "failed", { exit_status: 1, retried: true, started_at: iso(1000), finished_at: iso(73000) }));
  r = await call("GET", `${ciBase}/builds/${build1}`, B);
  check("the old job is marked retried, and does not report", r.json?.jobs?.find((j) => j.id === "job-ci-1")?.retried === true && (await statusOf("ci"))?.state === "pending");

  // Builds that are not this monorepo's.
  r = await send("build.scheduled", { build: bkBuild("other", 5, { commit: head2 }), pipeline: bkPipeline("other") });
  check("a pipeline that builds no repo here: ignored", r.json?.result === "ignored" && /builds no repo/.test(r.json.reason ?? ""));
  r = await send("build.scheduled", { build: bkBuild("p", 6, { commit: head2, meta_data: { pando_monorepo: "m_ffffffffffffffff", pando_repo: M } }), pipeline: bkPipeline("p") });
  check("another monorepo's build: ignored", r.json?.result === "ignored" && /another monorepo/.test(r.json.reason ?? ""));
  r = await send("build.scheduled", { build: bkBuild("p", 7, { commit: head2 }, "elsewhere"), pipeline: bkPipeline("p", "elsewhere") });
  check("another organization's build: ignored", r.json?.result === "ignored" && /organization/.test(r.json.reason ?? ""));

  // A build started in Buildkite, not by Pando: mapped by its pipeline.
  const B2 = (state, o = {}) => ({ build: bkBuild("p", 2, { state, commit: head2, branch: "feat", message: "from Buildkite", created_at: iso(2000), ...o }), pipeline: bkPipeline("p") });
  r = await send("build.running", B2("running", { started_at: iso(3000) }));
  const build2 = r.json?.build;
  r = await call("GET", `${ciBase}/builds?pipeline=p&limit=1`, B);
  check("a build started in Buildkite maps by its pipeline; who pushed comes from Pando's push record", r.json?.builds?.[0]?.id === build2 && r.json.builds[0].pushed_by === `ci-${id}` && !!r.json.next_cursor);
  r = await call("GET", `${ciBase}/builds?pipeline=p&limit=1&cursor=${r.json?.next_cursor}`, B);
  check("the next page has the older build", r.json?.builds?.[0]?.id === build1);
  r = await call("GET", `${ciBase}/builds?sha=${head2}&state=failed`, B);
  check("filters: sha and state", r.json?.builds?.length === 1 && r.json.builds[0].id === build1);
  r = await call("GET", ciBase, B);
  check("the pipeline's last build is the newest", r.json?.pipelines?.find((x) => x.slug === "p")?.last_build?.id === build2);
  await send("job.finished", { ...B2("running", { started_at: iso(3000) }), job: bkJob("job-late-1", "late", { state: "passed", exit_status: 0, created_at: iso(-1000) }) });
  await send("job.finished", { ...B1("failed", { started_at: iso(1000), finished_at: iso(75000) }), job: bkJob("job-old-1", "old-only", { state: "passed", exit_status: 0 }) });
  check("an older build of the same commit and pipeline reports no check", !(await statusOf("old-only")) && (await statusOf("late"))?.state === "success");

  // Details from Buildkite, cached.
  const tailText = "\nFAIL test/gitwrite.test.ts > push reuses the cached write token\nTests 1 failed, 41 passed (42)\n";
  bkStub.logs["job-tc-1"] = "x".repeat(1.5 * 1024 * 1024) + tailText;
  const logCalls = (job) => bkStub.calls.filter((x) => x.endsWith(`/jobs/${job}/log`)).length;
  r = await call("GET", `${ciBase}/builds/${build1}/jobs/job-tc-1/log`, B);
  check("a job's log from Buildkite: its last 1 MiB, the end kept", r.status === 200 && r.json?.bytes === 1 << 20 && r.json.total_bytes === 1.5 * 1024 * 1024 + tailText.length && r.json.truncated === true && r.json.content.endsWith(tailText) && r.json.cached === false && r.json.complete === false);
  r = await call("GET", `${ciBase}/builds/${build1}/jobs/job-tc-1/log`, B);
  check("read again at once: from the cache (10 s while unsettled), one call to Buildkite", r.json?.cached === true && logCalls("job-tc-1") === 1 && /no-store/.test(r.headers.get("cache-control") ?? ""));
  await send("job.finished", { ...B2("running", { started_at: iso(3000) }), job: bkJob("job-lint-2", "lint", { state: "passed", exit_status: 0, created_at: iso(-200000), started_at: iso(-180000), finished_at: iso(-120000) }) });
  bkStub.logs["job-lint-2"] = "lint ok\n";
  r = await call("GET", `${ciBase}/builds/${build2}/jobs/job-lint-2/log`, B);
  const r2 = await call("GET", `${ciBase}/builds/${build2}/jobs/job-lint-2/log`, B);
  check("a settled job's log is complete and cached for good", r.json?.complete === true && r.json.content === "lint ok\n" && /immutable/.test(r.headers.get("cache-control") ?? "") && r2.json?.cached === true && logCalls("job-lint-2") === 1);
  r = await call("GET", `${ciBase}/builds/${build1}/jobs/nope/log`, B);
  check("a job not in the build: 404, no call", r.status === 404 && logCalls("nope") === 0);
  bkStub.annotations = [{ id: "an-1", context: "test-summary", style: "error", body_html: "<p><b>1 failed</b>, 41 passed</p>", created_at: iso(0), updated_at: iso(0) }];
  bkStub.artifacts = [{ id: "art-1", job_id: "job-ci-1", url: "x", download_url: "x", state: "finished", path: "test-results/junit.xml", dirname: "test-results", filename: "junit.xml", mime_type: "application/xml", file_size: 38912, sha1sum: "abc" }];
  r = await call("GET", `${ciBase}/builds/${build1}/annotations`, B);
  check("a build's annotations (Buildkite's HTML, the web sanitises it)", r.json?.annotations?.[0]?.style === "error" && r.json.annotations[0].context === "test-summary" && r.json.annotations[0].body_html.includes("1 failed"));
  r = await call("GET", `${ciBase}/builds/${build1}/artifacts`, B);
  check("a build's artifacts", r.json?.artifacts?.[0]?.path === "test-results/junit.xml" && r.json.artifacts[0].size === 38912 && r.json.artifacts[0].job === "job-ci-1");
  r = await call("GET", `${ciBase}/builds/${build1}/artifacts/art-1/download`, B);
  check("Download: a 302 to Buildkite's short-lived URL", r.status === 302 && r.headers.get("location") === "https://artifacts.example/signed/art-1?expires=60");
  r = await call("GET", `${ciBase}/builds/${build1}/artifacts/art-x/download`, B);
  check("an artifact of another build: 404", r.status === 404);

  // The pipeline's page.
  r = await call("GET", `${ciBase}/pipelines/p`, B);
  const cfgCalls = () => bkStub.calls.filter((x) => x === "GET /v2/organizations/o/pipelines/p").length;
  check("a pipeline's page: pipeline.yml from Buildkite, its repo, its builds", r.json?.pipeline?.configuration === bkStub.pipelineYaml && r.json.pipeline.repo === M && r.json.pipeline.configuration_error === null && r.json.builds?.length === 2);
  r = await call("GET", `${ciBase}/pipelines/p`, B);
  check("pipeline.yml is read from Buildkite at most every 5 minutes", cfgCalls() === 1 && r.json?.pipeline?.configuration === bkStub.pipelineYaml);
  r = await call("GET", `${ciBase}/pipelines/nope`, B);
  check("an unknown pipeline: 404", r.status === 404);

  // Cancel and Rebuild.
  r = await call("POST", `${ciBase}/builds/${build1}/cancel`, B);
  check("Cancel a finished build: 409", r.status === 409 && r.json?.error?.code === "ci_finished");
  r = await call("POST", `${ciBase}/builds/${build2}/cancel`, B);
  check("Cancel a running build: passed to Buildkite, the build canceling", r.status === 202 && r.json?.build?.service_state === "canceling" && bkStub.calls.includes("PUT /v2/organizations/o/pipelines/p/builds/2/cancel"));
  r = await call("POST", `${ciBase}/builds/${build1}/rebuild`, B);
  const rebuilt = r.json?.build;
  const sent = bkStub.created.at(-1) ?? {};
  const rc = sent.env?.PANDO_STATUS_TOKEN ? claimsOf(sent.env.PANDO_STATUS_TOKEN) : {};
  const rexp = Number(/\?expires=(\d+)/.exec(sent.env?.PANDO_READ_TOKEN ?? "")?.[1]);
  check("Rebuild: a new build of the same commit, recorded at once, who pushed kept", r.status === 201 && rebuilt?.number === 100 && rebuilt.sha === head2 && rebuilt.rebuilt_from === "bld-p-1" && rebuilt.pushed_by === `ci-${id}`);
  check("... with fresh tokens: a status token for the commit (app buildkite) and a read token for 24 hours or more",
    sent.commit === head2 && rc.s === head2 && rc.a === "buildkite" && rc.m === MID && rc.h === `ci:${conn.id}` && rexp * 1000 - Date.now() > 24 * 3600_000 - 120_000 && sent.meta_data?.pando_rebuild_of === "bld-p-1" && sent.meta_data.pando_monorepo === MID);
  r = await call("POST", `/v1/monorepos/${O}/${M}/repos/${M}/statuses/${head2}`, sent.env?.PANDO_STATUS_TOKEN, { state: "success", context: "rebuilt" });
  check("the rebuild's status token posts", r.status === 201 && r.json?.app === "buildkite");

  r = await call("DELETE", `${ciBase}/connections/${conn.id}`, B);
  check("a member cannot disconnect", r.status === 403);
  check("every call to Buildkite carried BUILDKITE_API_TOKEN", bkStub.calls.length > 0 && bkStub.badAuth === 0, `${bkStub.calls.length} calls`);

  // Buildkite's rate limit: a 429 stops this connection's calls until its reset.
  bkStub.rateLimited = true;
  r = await call("GET", `${ciBase}/builds/${rebuilt?.id}/annotations`, B);
  check("a 429 from Buildkite: 503 ci_rate_limited with retry_after_ms", r.status === 503 && r.json?.error?.code === "ci_rate_limited" && r.json.error.retry_after_ms >= 25_000);
  bkStub.rateLimited = false;
  const before = bkStub.calls.length;
  r = await call("GET", `${ciBase}/builds/${rebuilt?.id}/artifacts`, B);
  check("then no call reaches Buildkite until the reset", r.status === 503 && r.json?.error?.code === "ci_rate_limited" && bkStub.calls.length === before);

  r = await call("DELETE", `${ciBase}/connections/${conn.id}`, S);
  check("an owner disconnects", r.status === 204);
  r = await call("GET", ciBase, S);
  const left = (await call("GET", `${ciBase}/builds`, S)).json?.builds ?? [];
  check("its connection, pipelines and builds are gone; its checks stay", r.json?.connections?.length === 0 && r.json.pipelines.length === 0 && left.length === 0 && (await statusOf("typecheck"))?.app === "buildkite");
  r = await send("ping", {}, { token: true });
  check("its webhook URL answers 404", r.status === 404);

  // `pando ci`, the cli, as the owner signed in on this machine (PANDO_HOME in the test's folder).
  const pandoEnv = { ...process.env, PANDO_HOME: join(work, "pando-home-ci"), PANDO_SERVER: "", PANDO_TOKEN: "" };
  const pando = (args, input) => spawnSync(bin, args, { cwd: work, env: pandoEnv, encoding: "utf8", input });
  const login = pando(["login", "--server", URL_, "--with-credential"], S + "\n");
  check("pando login --with-credential (piped)", login.status === 0, scrub(login.stderr).trim().slice(0, 200));
  const MO = `${O}/${M}`;
  let cmd = pando(["ci", "connect", "--org", "o", "--monorepo", MO]);
  check("pando ci connect into a pipe (as an agent would): refused, nothing made", cmd.status !== 0 && /own terminal/.test(cmd.stderr) && (await call("GET", ciBase, S)).json?.connections?.length === 0);
  const tokFile = join(work, "bk-webhook-token");
  cmd = pando(["ci", "connect", "--org", "o", "--monorepo", MO, "--out", tokFile]);
  const cliToken = readFileSync(tokFile, "utf8").trim();
  const cliConn = (await call("GET", ciBase, S)).json?.connections?.[0];
  check("pando ci connect --out: connected, the token only in the file (mode 600), the URL and Buildkite's steps printed",
    cmd.status === 0 && cliToken.length >= 32 && !cmd.stdout.includes(cliToken) && (statSync(tokFile).mode & 0o777) === 0o600 &&
    cmd.stdout.includes(cliConn?.webhook_url ?? "?") && /Settings > Notification Services/.test(cmd.stdout) && /X-Buildkite-Signature/.test(cmd.stdout), scrub(cmd.stderr).trim());
  const cliHook = `/v1/integrations/buildkite/${cliConn?.id}`;
  const signed = (key) => {
    const body = JSON.stringify({ event: "ping" });
    const ts = Math.floor(Date.now() / 1000);
    return call("POST", cliHook, null, body, { "x-buildkite-event": "ping", "x-buildkite-signature": `timestamp=${ts},signature=${createHmac("sha256", key).update(`${ts}.${body}`).digest("hex")}` });
  };
  r = await signed("not-the-token");
  check("a webhook signed with another key: 401", r.status === 401);
  r = await signed(cliToken);
  check("a webhook signed with the file's token: recorded", r.status === 200 && r.json?.result === "recorded");
  cmd = pando(["ci", "status", "--monorepo", MO]);
  check("pando ci status: the webhook URL, the last event (ping, recorded) and the last refusal, and no token",
    cmd.status === 0 && cmd.stdout.includes(cliConn?.webhook_url ?? "?") && /last event\s+ping .*recorded/.test(cmd.stdout) &&
    /last refused\s+.*X-Buildkite-Signature does not match/.test(cmd.stdout) && !cmd.stdout.includes(cliToken), scrub(cmd.stdout + cmd.stderr).trim().split("\n").slice(0, 4).join(" | "));
  cmd = pando(["ci", "connect", "--org", "o", "--monorepo", MO, "--out", join(work, "again")]);
  check("connecting twice says how to start over", cmd.status !== 0 && /pando ci disconnect --org o/.test(cmd.stderr));
  // `pando ci pipeline`: a repo's buildkite hook without hand-crafting the POST. (No pushes while the
  // hook it adds exists: that hook has no test api_url, so a push would call the real Buildkite.)
  const bkHooks = async () => ((await call("GET", `${base}/hooks`, S)).json?.hooks ?? []).filter((h) => h.type === "buildkite");
  cmd = pando(["ci", "pipeline", "add", M, "p2", "--monorepo", MO]);
  let hooks2 = await bkHooks();
  check("pando ci pipeline add <repo> <pipeline> (owner): a buildkite hook for the connected organization",
    cmd.status === 0 && hooks2.some((h) => h.buildkite?.organization === "o" && h.buildkite?.pipeline === "p2") && /each push to a branch now starts a build of o\/p2/.test(cmd.stdout), scrub(cmd.stderr).trim());
  cmd = pando(["ci", "pipeline", "add", M, "p2", "--monorepo", MO]);
  check("adding it again adds nothing", cmd.status === 0 && /already starts/.test(cmd.stdout) && (await bkHooks()).length === hooks2.length);
  cmd = pando(["ci", "pipeline", "list", "--monorepo", MO]);
  check("pando ci pipeline list: both pipelines this repo starts", cmd.status === 0 && /o\/p\b/.test(cmd.stdout) && /o\/p2/.test(cmd.stdout));
  const memberEnv = { ...pandoEnv, PANDO_HOME: join(work, "pando-home-member") };
  spawnSync(bin, ["login", "--server", URL_, "--with-credential"], { cwd: work, env: memberEnv, encoding: "utf8", input: B + "\n" });
  const asMember = spawnSync(bin, ["ci", "pipeline", "add", M, "p3", "--monorepo", MO], { cwd: work, env: memberEnv, encoding: "utf8" });
  check("a member (not an owner) is told only an owner can add a pipeline", asMember.status !== 0 && /only an owner of .* can add a pipeline/.test(asMember.stderr) && !(await bkHooks()).some((h) => h.buildkite?.pipeline === "p3"));
  cmd = pando(["ci", "pipeline", "remove", M, "p2", "--monorepo", MO]);
  hooks2 = await bkHooks();
  check("pando ci pipeline remove", cmd.status === 0 && !hooks2.some((h) => h.buildkite?.pipeline === "p2") && hooks2.some((h) => h.buildkite?.pipeline === "p"));
  cmd = pando(["ci", "disconnect", "--org", "o", "--monorepo", MO]);
  check("pando ci disconnect", cmd.status === 0 && (await call("GET", ciBase, S)).json?.connections?.length === 0);
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  for (const name of made) {
    const r = await call("DELETE", `/v1/monorepos/${O}/${name}?confirm=${O}/${name}`, S);
    check(`delete ${name}`, r.status === 204);
  }
  server.close();
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
