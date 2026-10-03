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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// ── the receivers: Buildkite's create-build, and two web hooks ──
const got = { buildkite: [], web: [] };
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
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

  // ── 2. Buildkite ── (next)
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
