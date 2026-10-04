// Mirror to GitHub, end to end, against a stand-in GitHub on this machine
// (test/git-standin.mjs: real git http-backend, the REST calls, the pages,
// an LFS endpoint). It starts its own `wrangler dev` (real D1, Durable
// Objects and Artifacts) with the stand-in's addresses and a throwaway app
// key it makes here, then checks SPEC 6.4's list. Each test repository is
// deleted at the end. Credentials are never printed.
//
//   node test/mirror.mjs        (ports: worker 8831, inspector 9331, stand-in 8835; MIRROR_PORT etc. to change)
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryResetFetch, throwaways } from "./errors.mjs";
import { startGitStandin } from "./git-standin.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const PORT = Number(process.env.MIRROR_PORT ?? 8831);

const INSPECTOR = Number(process.env.MIRROR_INSPECTOR_PORT ?? 9331);

const STANDIN = Number(process.env.MIRROR_STANDIN_PORT ?? 8835);

const URL_ = `http://localhost:${PORT}`;

const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const WORKER = new URL("..", import.meta.url).pathname;

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`.replace(/gh[su]_test_[A-Za-z0-9_]+/g, "<token>"));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (pred, ms = 30_000) => {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await pred();

    if (v) return v;
    await sleep(300);
  }

  return null;
};

// ── The worker, with the stand-in's addresses and a throwaway app key ──
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

const state = mkdtempSync(join(tmpdir(), "pando-mirror-state-"));

const work = mkdtempSync(join(tmpdir(), "pando-mirror-work-"));

const S0 = `http://127.0.0.1:${STANDIN}`;

const vars = {
  MIRROR_TEST: "1",
  GITHUB_APP_SLUG: "pando-test",
  GITHUB_APP_CLIENT_ID: "Iv-test",
  GITHUB_APP_CLIENT_SECRET: "test-secret",
  GITHUB_APP_PRIVATE_KEY: Buffer.from(privateKey).toString("base64"),
  GITHUB_API_BASE: `${S0}/api`,
  GITHUB_WEB_BASE: `${S0}/web`,
  GITHUB_GIT_BASE: `${S0}/git`,
  MIRROR_SPACING_MS: "3000",
  MIRROR_RETRY_MS: "1500,2500,4000",
};

spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "pando-accounts-dev", "--local", "--persist-to", state], { cwd: WORKER, encoding: "utf8" });

const wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--inspector-port", String(INSPECTOR), "--persist-to", state, ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])], { cwd: WORKER, stdio: ["ignore", "pipe", "pipe"], detached: true });

// The server's own lines, for a failed check (never printed whole: it can hold request details).
const LOG = process.env.MIRROR_LOG ?? join(tmpdir(), "pando-mirror-wrangler.log");

writeFileSync(LOG, "");

let log = "";

const keep = (d) => {
  log = (log + d).slice(-20_000);
  appendFileSync(LOG, d);
};

wrangler.stdout.on("data", keep);

wrangler.stderr.on("data", keep);

const standin = await startGitStandin(STANDIN, { publicKey, callback: `${URL_}/v1/github/callback` });

const up = await waitFor(async () => (await fetch(`${URL_}/healthz`).catch(() => null))?.ok, 90_000);

if (!up) {
  console.log(log.slice(-2000));
  throw new Error("wrangler dev did not start");
}

// A write sent on a kept-alive socket the server had closed (while git ran here) never reached it: send it again once.
const call = async (method, path, secret, body) => {
  try {
    return await request(URL_, method, path, { secret, body });
  } catch (err) {
    if (!/ECONNRESET|socket|other side closed/i.test(String(err?.cause ?? err))) throw err;

    return request(URL_, method, path, { secret, body });
  }
};

// The contract's recordings of the mirror's answers (packages/contract/recorded, checked by check-recorded.ts).
const RECORDED = new URL("../../packages/contract/recorded/", import.meta.url);

const record = (file, schema, route, r) => {
  if (r?.status >= 200 && r.status < 300 && r.json) writeFileSync(new URL(file, RECORDED), `${JSON.stringify({ schema, route, status: r.status, body: r.json }, null, 2)}\n`);
};

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, S)).status);

// ── A browser's cookies, for the connect flow (fetch keeps none) ──
const jar = new Map();

const nav = async (url, secret = null) => {
  const headers = {};

  if (secret) headers.authorization = `Bearer ${secret}`;
  const c = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

  if (c && url.startsWith(URL_)) headers.cookie = c;
  const res = await fetch(url, { headers, redirect: "manual" });

  for (const sc of res.headers.getSetCookie()) {
    const kv = sc.split(";")[0];
    const i = kv.indexOf("=");

    if (/Max-Age=0\b/.test(sc)) jar.delete(kv.slice(0, i));
    else jar.set(kv.slice(0, i), kv.slice(i + 1));
  }

  return { status: res.status, location: res.headers.get("location"), text: await res.text() };
};

/** Follow redirects from Pando through the stand-in and back; `edit` may change a URL on the way. */
const follow = async (start, secret, edit = (u) => u) => {
  let url = start.startsWith("/") ? URL_ + start : start;
  const seen = [];

  for (let i = 0; i < 12; i++) {
    url = edit(url);
    seen.push(url.replace(/code=[^&]+/, "code=<code>"));
    const r = await nav(url, url.startsWith(URL_) ? secret : null);

    if (r.status !== 302) return { ...r, url, seen };
    url = r.location.startsWith("/") ? URL_ + r.location : r.location;
  }

  return { status: 0, url, seen };
};

const id = Date.now().toString(36);

const O = `mr-${id}`;

const M = `mr-${id}`;

let S = null;

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Ana Lee", GIT_AUTHOR_EMAIL: "ana@pando.invalid", GIT_COMMITTER_NAME: "Ana Lee", GIT_COMMITTER_EMAIL: "ana@pando.invalid" };

const git = (a, cwd) => spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...a], { cwd, env: { ...env, PANDO_SECRET: S }, encoding: "utf8" });

const blobSha = (bytes) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");

try {
  S = (await call("POST", "/v1/users", BOOT, { login: O })).json?.credential?.secret;
  let r = await call("POST", "/v1/monorepos", S, { name: M });

  if (r.status === 201) tw.add(`${O}/${M}`);
  r = await call("POST", `/v1/monorepos/${O}/${M}/repos`, S, { path: "projects/app" });
  const url = r.json?.clone_url;
  const APP = r.json?.name; // the project's repo name: its path with / as - (projects-app)
  check("a repository with a project (projects/app)", !!S && r.status === 201 && !!url && !!APP, `${r.status} ${APP}`);
  const src = join(work, "app");
  mkdirSync(src);
  git(["init", "-q"], src);
  mkdirSync(join(src, ".github", "workflows"), { recursive: true });
  writeFileSync(join(src, ".github", "workflows", "ci.yml"), "on: push\n");
  writeFileSync(join(src, "README.md"), "app\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  check("main made by the first push", git(["push", "-q", url, "main"], src).status === 0);
  const pandoMain = async () => (await call("GET", `/v1/monorepos/${O}/${M}/heads`, S)).json?.heads?.find((h) => h.repo === APP)?.head ?? null;
  let n = 0;

  const merge = async (file = `f${++n}`, message = `change ${n}`) => {
    git(["checkout", "-q", "-B", `b${n}`, "main"], src);
    git(["pull", "-q", url, "main"], src);
    writeFileSync(join(src, file), `${n} ${randomBytes(4).toString("hex")}\n`);
    git(["add", "-A"], src);
    git(["commit", "-qm", message], src);
    git(["push", "-q", url, `b${n}`], src);
    const m = await call("POST", `/v1/monorepos/${O}/${M}/repos/${APP}/branches/b${n}/merge?force=1`, S);

    return m.json?.sha ?? null;
  };

  const mirror = async () => (await call("GET", `/v1/monorepos/${O}/${M}/mirror`, S)).json;
  const target = async (repo) => (await mirror())?.targets?.find((t) => t.repo === repo);
  const onGithub = (full) => standin.git(full, "rev-parse", "--verify", "-q", "refs/heads/main").stdout.trim();

  // 0. Before connecting.
  record("mirror-off.json", "Mirror", "GET .../mirror (not connected)", await call("GET", `/v1/monorepos/${O}/${M}/mirror`, S));
  let mv = await mirror();
  check("off: no connection, the app is set up, the switch off", mv?.connection === null && mv?.app?.configured === true && mv?.on === false, JSON.stringify(mv)?.slice(0, 160));

  // 1. Connect: GitHub's authorization, no installation yet, the install, back, linked.
  standin.addInstallation(7, "someone-else", false);
  standin.addRepo(7, "someone-else/secret");
  const c1 = await follow(`/v1/monorepos/${O}/${M}/mirror/connect?purpose=connect`, S);
  check(
    "connect: Pando, GitHub's authorization, the install, back to Settings (step 2)",
    c1.status === 200 && c1.url.endsWith('/settings?mirror=match') && c1.seen.some((u) => u.includes("/installations/new")),
    c1.seen.map((u) => u.replace(URL_, "").replace(S0, "gh").split("?")[0]).join(" > "),
  );
  mv = await mirror();
  const inst = mv?.connection?.installation_id;
  check("linked to the person's own installation, on their account", inst >= 100 && mv?.connection?.login === "backnotprop", JSON.stringify(mv?.connection));
  // A faked installation number in GitHub's answer: Pando links only what the person reaches.
  const c2 = await follow(`/v1/monorepos/${O}/${M}/mirror/connect?purpose=connect`, S, (u) => (u.includes("/v1/github/callback?") ? `${u}&installation_id=7` : u));
  mv = await mirror();
  check("a faked installation_id (someone else's) is never linked", c2.status === 200 && mv?.connection?.installation_id === inst, `${mv?.connection?.installation_id}`);
  const bogus = await nav(`${URL_}/v1/github/callback?code=x&state=bogus`);
  check("a state that is not this browser's is refused", bogus.status === 400, `${bogus.status}`);

  // 2. Each project: the project to an existing GitHub repo; the files outside projects/ to one Pando creates.
  const appGh = standin.addRepo(inst, "backnotprop/app", false);
  const reposAnswer = await call("GET", `/v1/monorepos/${O}/${M}/mirror/github-repos`, S);
  record("mirror-github-repos.json", "GithubRepos", "GET .../mirror/github-repos", reposAnswer);
  const repos = reposAnswer.json;
  check("Change lists the installation's repositories (not someone else's)", repos?.repos?.some((x) => x.full_name === "backnotprop/app") && !repos?.repos?.some((x) => x.full_name.startsWith("someone-else")));
  check("the app's JWT: RS256 signed with the app key, the Client ID as issuer, at most 10 minutes", standin.jwts.length > 0 && standin.jwts.every((j) => j.iss === "Iv-test" && j.exp - j.iat <= 600), `${standin.jwts.length} checked`);
  // Shared files first, so the files outside projects/ have a repo.
  const WS_ = URL_.replace(/^http/, "ws");
  const frames = [];
  const ws = new WebSocket(`${WS_}/v1/monorepos/${O}/${M}/meta/socket`, { headers: { authorization: `Bearer ${S}` } });
  ws.onmessage = (m) => frames.push(JSON.parse(m.data));
  ws.onerror = () => {};

  await waitFor(() => ws.readyState === 1, 10_000);
  ws.send(JSON.stringify({ type: "hello", since: 0, machine: "mr-mbp", agent: null, client: "mirror-test/1" }));
  await waitFor(() => frames.find((f) => f.type === "caught_up"), 10_000);
  const big = randomBytes(2 * 1024 * 1024);
  const oid = createHash("sha256").update(big).digest("hex");
  const put = await fetch(`${URL_}/v1/monorepos/${O}/${M}/meta/blobs/${oid}`, { method: "PUT", headers: { authorization: `Bearer ${S}`, "content-length": String(big.length) }, body: big });
  const pointer = Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${big.length}\n`);
  ws.send(JSON.stringify({ type: "save", id: "s1", path: "notes/plan.md", base_version: 0, sha: blobSha(Buffer.from("# plan\n")), bytes: Buffer.from("# plan\n").toString("base64") }));
  ws.send(JSON.stringify({ type: "save", id: "s2", path: "art/big.bin", base_version: 0, sha: blobSha(pointer), bytes: pointer.toString("base64") }));
  const saved = await waitFor(() => frames.filter((f) => f.type === "accepted").length >= 2, 10_000);
  check("shared files saved, a 2 MiB file as a pointer with its bytes in R2", put.ok && saved);
  const metaCommitted = await waitFor(async () => (await call("GET", `/v1/monorepos/${O}/${M}/meta/status`, S)).json?.last_commit ?? null, 40_000);
  check("the shared files are committed (their git repo exists)", !!metaCommitted);

  r = await call("PUT", `/v1/monorepos/${O}/${M}/mirror/targets`, S, {
    mode: "projects",
    targets: [{ repo: APP, github_id: appGh.id, on: true }, { repo: "meta", create: { name: `${M}-files` }, on: true }],
  });
  record("mirror-saved-authorize.json", "MirrorSaved", "PUT .../mirror/targets (a Create row: authorize first)", r);
  check("Start mirroring with a Create row asks for GitHub's authorization first", r.status === 200 && (r.json?.authorize_url ?? "").endsWith("/mirror/connect?purpose=create"), JSON.stringify(r.json?.authorize_url));
  const c3 = await follow(r.json.authorize_url, S);
  const filesFull = `backnotprop/${M}-files`;
  check("Create: back from GitHub, the repository made private on the person's account", c3.status === 200 && c3.url.endsWith('/settings') && standin.repos.get(inst).some((x) => x.full_name === filesFull && x.private));
  const mainNow = await pandoMain();
  const landed = await waitFor(() => onGithub("backnotprop/app") === mainNow, 30_000);
  check("each project: GitHub's main is Pando's main, the same commit id", !!landed && !!mainNow, `${mainNow?.slice(0, 7)}`);
  check("git fsck is clean on GitHub's copy, and the workflow file is there", standin.git("backnotprop/app", "fsck", "--no-progress").status === 0 && standin.git("backnotprop/app", "cat-file", "-e", "main:.github/workflows/ci.yml").status === 0);
  const filesLanded = await waitFor(() => onGithub(filesFull), 40_000);
  check("the files outside projects/ reached their own repository", !!filesLanded && standin.git(filesFull, "cat-file", "-e", "main:notes/plan.md").status === 0);
  check("their large file went to GitHub's LFS first (the pointer stays a pointer in git)", standin.lfs.has(oid) && standin.lfs.get(oid).length === big.length && standin.git(filesFull, "show", "main:art/big.bin").stdout.includes(oid));
  let t = await waitFor(async () => ((await target(APP))?.state === "up_to_date" ? target(APP) : null), 15_000);
  record("mirror-on.json", "Mirror", "GET .../mirror (each project, up to date)", await call("GET", `/v1/monorepos/${O}/${M}/mirror`, S));
  check("the row says up to date, with the commit sent", t?.state === "up_to_date" && t?.last?.commit === mainNow, JSON.stringify(t)?.slice(0, 200));

  // 3. A merge.
  const t0 = Date.now();
  let sha = await merge();
  const m1 = await waitFor(() => onGithub("backnotprop/app") === sha, 20_000);
  check("a merge reaches GitHub", !!m1, `${Date.now() - t0} ms after the merge answered`);

  // 4. Many merges back to back: few pushes, the last state. Ten branches first, each its own file, then ten merges.
  git(["checkout", "-q", "-B", "base", "main"], src);
  git(["pull", "-q", url, "main"], src);

  for (let i = 0; i < 10; i++) {
    git(["checkout", "-q", "-B", `burst${i}`, "base"], src);
    writeFileSync(join(src, `burst${i}`), `${i}\n`);
    git(["add", "-A"], src);
    git(["commit", "-qm", `burst ${i}`], src);
    git(["push", "-q", url, `burst${i}`], src);
  }

  const p0 = standin.pushes("backnotprop/app");
  const t1 = Date.now();

  for (let i = 0; i < 10; i++) await call("POST", `/v1/monorepos/${O}/${M}/repos/${APP}/branches/burst${i}/merge?force=1`, S);
  sha = await pandoMain();
  const m2 = await waitFor(() => onGithub("backnotprop/app") === sha, 30_000);
  const pushed = standin.pushes("backnotprop/app") - p0;
  check("10 merges: GitHub ends at the last, in fewer pushes than merges (one per spacing)", !!m2 && pushed < 10, `${pushed} pushes over ${Date.now() - t1} ms${m2 ? "" : `; the row: ${JSON.stringify(await target(APP))}`}`);

  // 5. Retry with nothing new: no receive-pack.
  const p1 = standin.pushes("backnotprop/app");
  r = await call("POST", `/v1/monorepos/${O}/${M}/mirror/run`, S, { repos: [APP] });
  await sleep(3000);
  record("mirror-queued.json", "MirrorQueued", "POST .../mirror/run", r);
  check("Retry with nothing new sends no push", r.status === 202 && standin.pushes("backnotprop/app") === p1, JSON.stringify(r.json));

  // 6. What lands on GitHub is overwritten.
  // A commit made on GitHub's side, in the bare repository itself (git over HTTP to the stand-in from here would block
  // the stand-in, which runs in this process).
  const appTree = standin.git("backnotprop/app", "rev-parse", "main^{tree}").stdout.trim();
  const theirs = standin.git("backnotprop/app", "-c", "user.name=Someone", "-c", "user.email=someone@github.invalid", "commit-tree", appTree, "-p", "main", "-m", "pushed on GitHub").stdout.trim();
  standin.git("backnotprop/app", "update-ref", "refs/heads/main", theirs);
  sha = await merge();
  const m3 = await waitFor(() => onGithub("backnotprop/app") === sha, 20_000);
  check("a commit pushed to GitHub directly is overwritten by the next run", theirs !== sha && !!m3 && standin.git("backnotprop/app", "merge-base", "--is-ancestor", theirs, "main").status !== 0);

  // 7. The switch off, a merge, behind; on again. A project switched off.
  r = await call("PATCH", `/v1/monorepos/${O}/${M}/mirror`, S, { on: false });
  sha = await merge();
  await sleep(3000);
  t = await target(APP);
  check("switched off: GitHub does not move, the row is paused and behind", r.status === 200 && onGithub("backnotprop/app") !== sha && t?.state === "paused" && t?.behind === 1, JSON.stringify({ state: t?.state, behind: t?.behind }));
  r = await call("PATCH", `/v1/monorepos/${O}/${M}/mirror`, S, { on: true });
  check("switched on: everything goes in one run", !!(await waitFor(() => onGithub("backnotprop/app") === sha, 20_000)));
  r = await call("PUT", `/v1/monorepos/${O}/${M}/mirror/targets`, S, { mode: "projects", targets: [{ repo: APP, github_id: appGh.id, on: false }, { repo: "meta", github_id: standin.repos.get(inst).find((x) => x.full_name === filesFull).id, on: true }] });
  const p2 = standin.pushes("backnotprop/app");
  sha = await merge();
  await sleep(3500);
  t = await target(APP);
  record("mirror-saved.json", "MirrorSaved", "PUT .../mirror/targets (a project switched off)", r);
  check("a project switched off: its merges start no run, the row says off", r.status === 200 && standin.pushes("backnotprop/app") === p2 && t?.state === "off", t?.state);
  await call("PUT", `/v1/monorepos/${O}/${M}/mirror/targets`, S, { mode: "projects", targets: [{ repo: APP, github_id: appGh.id, on: true }, { repo: "meta", github_id: standin.repos.get(inst).find((x) => x.full_name === filesFull).id, on: true }] });
  await waitFor(() => onGithub("backnotprop/app") === sha, 20_000);

  // 8. GitHub not answering: retrying, then up to date.
  standin.fail(/\/git\/backnotprop\/app\.git\/info\/refs$/, 503, 2);
  sha = await merge();
  const retrying = await waitFor(async () => ((await target(APP))?.state === "retrying" ? target(APP) : null), 15_000);
  const m4 = await waitFor(() => onGithub("backnotprop/app") === sha, 30_000);
  check("GitHub answering 503: the row says retrying, then the merge lands", !!retrying && !!m4, retrying?.problem?.message);

  // 9. A refusal: a pre-receive hook (GitHub's protected main), with its words; Retry after it is fixed.
  const hook = join(standin.bare("backnotprop/app"), "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'error: GH006: Protected branch update failed for refs/heads/main.' >&2\nexit 1\n", { mode: 0o755 });
  sha = await merge();
  const refused = await waitFor(async () => ((await target(APP))?.state === "refused" ? target(APP) : null), 20_000);
  check("a protected main: refused, said plainly", !!refused && /protected/i.test(refused.problem?.message ?? ""), refused?.problem?.message);
  rmSync(hook);
  r = await call("POST", `/v1/monorepos/${O}/${M}/mirror/run`, S, { repos: [APP] });
  check("Retry after the fix lands it", r.status === 202 && !!(await waitFor(() => onGithub("backnotprop/app") === sha, 20_000)));

  // 10. Whole repository: one GitHub repository, created, the files outside projects/ at the top and projects/app under it.
  const before = await pandoMain();
  r = await call("PUT", `/v1/monorepos/${O}/${M}/mirror/targets`, S, { mode: "whole", targets: [{ repo: "*", create: { name: `${M}-all` }, on: true }] });
  await follow(r.json.authorize_url, S);
  const allFull = `backnotprop/${M}-all`;
  const w1 = await waitFor(() => onGithub(allFull), 40_000);
  const tree = standin.git(allFull, "ls-tree", "-r", "--name-only", "main").stdout.split("\n");
  record("mirror-whole.json", "Mirror", "GET .../mirror (whole repository)", await call("GET", `/v1/monorepos/${O}/${M}/mirror`, S));
  check("whole repository: the tree is the files outside projects/ plus projects/app", !!w1 && tree.includes("notes/plan.md") && tree.includes("projects/app/README.md") && tree.includes("projects/app/.github/workflows/ci.yml"), tree.slice(0, 6).join(", "));
  const first = standin.git(allFull, "log", "-1", "--format=%B", "main").stdout;
  check("its first commit names each source's Pando commit", /Mirror of /.test(first) && first.includes(`Pando-Commit: projects/app ${before}`), first.split("\n")[0]);
  check("project histories are kept in hidden refs, not branches", standin.git(allFull, "rev-parse", `refs/pando/${APP}`).stdout.trim() === before && standin.git(allFull, "branch", "--list").stdout.trim() === "* main");
  sha = await merge("whole.txt", "add whole.txt");
  const w2 = await waitFor(() => standin.git(allFull, "log", "-1", "--format=%B", "main").stdout.includes(`Pando-Commit: projects/app ${sha}`), 40_000);
  // The source commit is Pando's main after the merge (Pando's merge commit), kept on GitHub under its hidden ref.
  const last = standin.git(allFull, "log", "-1", "--format=%an|%ae|%s|%cn", "main").stdout.trim();
  const source = standin.git(allFull, "log", "-1", "--format=%an|%ae|%s", `refs/pando/${APP}`).stdout.trim();
  check("a change: one commit, the source commit's author and message, committed by Pando", !!w2 && last === `${source}|Pando` && standin.git(allFull, "cat-file", "-e", "main:projects/app/whole.txt").status === 0, last);

  // 11. Disconnect: everything goes from Pando; GitHub is untouched.
  const kept = onGithub(allFull);
  r = await call("DELETE", `/v1/monorepos/${O}/${M}/mirror`, S);
  mv = await mirror();
  check("Disconnect: no connection left, GitHub's repositories untouched", r.status === 204 && mv?.connection === null && onGithub(allFull) === kept && !!onGithub("backnotprop/app"));
  ws.close();
} catch (err) {
  check("no exception", false, String(err?.stack ?? err).slice(0, 600));
} finally {
  await tw.cleanup();
  await standin.close();

  try {
    process.kill(-wrangler.pid);
  } catch {
    // already gone
  }

  rmSync(state, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((x) => !x).length;

console.log(`\n${results.length - failed}/${results.length} passed`);

process.exit(failed ? 1 : 0);
