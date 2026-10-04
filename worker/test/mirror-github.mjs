// Mirror to GitHub against the real GitHub: the owner's dev app ("Pando
// Mirror Dev") and its private test repository (OWNER-SETUP.md, part A).
// Every value comes from worker/.dev.vars (copied from the owner's gate
// file) and is never printed; GitHub's refs are read by the Worker with its
// own token (/v1/_mirror/test remote-refs), so no token reaches this
// process. Skipped, saying why, while those values are missing.
//
//   node test/mirror-github.mjs        (ports: worker 8831, inspector 9331)
//
// Checks: the installation links (the test op stands in for the browser),
// a first run with a .github/workflows file (the Workflows permission), a
// merge reaching GitHub (its time printed), GitHub's main set back by hand
// and overwritten by the next run, the files outside projects/ with a large
// file (GitHub's LFS), and whole repository mode into the same repository
// (its hidden refs accepted by GitHub).
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryResetFetch, throwaways } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const vars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");

const v = (k) => new RegExp(`^${k}=(.*)$`, "m").exec(vars)?.[1]?.trim() || null;

const NEED = ["GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY", "GITHUB_TEST_INSTALLATION_ID", "GITHUB_TEST_REPO"];

const missing = NEED.filter((k) => !v(k));

if (missing.length) {
  console.log(`SKIP  the real-GitHub suite: worker/.dev.vars has no ${missing.join(", ")} (the owner's dev app, OWNER-SETUP.md part A)`);
  process.exit(0);
}

const PORT = Number(process.env.MIRROR_PORT ?? 8831);

const INSPECTOR = Number(process.env.MIRROR_INSPECTOR_PORT ?? 9331);

const URL_ = `http://localhost:${PORT}`;

const BOOT = v("PANDO_BOOTSTRAP");

const INSTALLATION = Number(v("GITHUB_TEST_INSTALLATION_ID"));

const TEST_REPO = v("GITHUB_TEST_REPO");

const WORKER = new URL("..", import.meta.url).pathname;

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`.replace(/gh[su]_[A-Za-z0-9_.-]+/g, "<token>"));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (pred, ms = 60_000) => {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const x = await pred();

    if (x) return x;
    await sleep(500);
  }

  return null;
};

const state = mkdtempSync(join(tmpdir(), "pando-mirror-gh-state-"));

const work = mkdtempSync(join(tmpdir(), "pando-mirror-gh-work-"));

spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "pando-accounts-dev", "--local", "--persist-to", state], { cwd: WORKER, encoding: "utf8" });

const wrangler = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--inspector-port", String(INSPECTOR), "--persist-to", state, "--var", "MIRROR_TEST:1", "--var", "MIRROR_SPACING_MS:10000"], {
  cwd: WORKER,
  stdio: "ignore",
  detached: true,
});

if (!(await waitFor(async () => (await fetch(`${URL_}/healthz`).catch(() => null))?.ok, 90_000))) throw new Error("wrangler dev did not start");

const call = (method, path, secret, body) => request(URL_, method, path, { secret, body });

const test = (body) => call("POST", "/v1/_mirror/test", BOOT, body);

const id = Date.now().toString(36);

const O = `mg-${id}`;

const M = `mg-${id}`;

let S = null;

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, S)).status);

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Pando Test", GIT_AUTHOR_EMAIL: "test@pando.invalid", GIT_COMMITTER_NAME: "Pando Test", GIT_COMMITTER_EMAIL: "test@pando.invalid" };

const git = (a, cwd) => spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...a], { cwd, env: { ...env, PANDO_SECRET: S }, encoding: "utf8" });

try {
  S = (await call("POST", "/v1/users", BOOT, { login: O })).json?.credential?.secret;
  let r = await call("POST", "/v1/monorepos", S, { name: M });
  const MID = r.json?.monorepo?.id;

  if (r.status === 201) tw.add(`${O}/${M}`);
  r = await call("POST", `/v1/monorepos/${O}/${M}/repos`, S, { path: "projects/app" });
  const url = r.json?.clone_url;
  const APP = r.json?.name;
  const src = join(work, "app");
  mkdirSync(src);
  git(["init", "-q"], src);
  mkdirSync(join(src, ".github", "workflows"), { recursive: true });
  writeFileSync(join(src, ".github", "workflows", "noop.yml"), "on: workflow_dispatch\njobs: {}\n");
  writeFileSync(join(src, "README.md"), `mirror test ${id}\n`);
  git(["add", "-A"], src);
  git(["commit", "-qm", `mirror test ${id}`], src);
  check("a repository with a project and a workflow file", !!MID && !!APP && git(["push", "-q", url, "main"], src).status === 0);

  r = await test({ op: "link", monorepo: MID, installation_id: INSTALLATION, by: O });
  check("the dev app's installation links", r.status === 200, `${r.status} ${r.json?.error?.message ?? ""}`);
  const repos = (await call("GET", `/v1/monorepos/${O}/${M}/mirror/github-repos`, S)).json?.repos ?? [];
  const gh = repos.find((x) => x.full_name === TEST_REPO);
  check("the installation reaches the test repository", !!gh, `${repos.length} repositories`);
  const refs = async () => (await test({ op: "remote-refs", installation_id: INSTALLATION, repo_id: gh.id, full_name: gh.full_name })).json?.refs ?? {};
  const head = async () => (await call("GET", `/v1/monorepos/${O}/${M}/heads`, S)).json?.heads?.find((h) => h.repo === APP)?.head ?? null;
  let n = 0;

  const merge = async () => {
    n++;
    git(["checkout", "-q", "-B", `b${n}`, "main"], src);
    git(["pull", "-q", url, "main"], src);
    writeFileSync(join(src, `f${n}`), `${n}\n`);
    git(["add", "-A"], src);
    git(["commit", "-qm", `change ${n}`], src);
    git(["push", "-q", url, `b${n}`], src);

    return (await call("POST", `/v1/monorepos/${O}/${M}/repos/${APP}/branches/b${n}/merge?force=1`, S)).json?.sha ?? null;
  };

  // 1. Each project: a first run with the workflow file.
  r = await call("PUT", `/v1/monorepos/${O}/${M}/mirror/targets`, S, { mode: "projects", targets: [{ repo: APP, github_id: gh.id, on: true }] });
  const main0 = await head();
  const t0 = Date.now();
  const first = await waitFor(async () => (await refs())["refs/heads/main"] === main0, 90_000);
  const row = (await call("GET", `/v1/monorepos/${O}/${M}/mirror`, S)).json?.targets?.find((t) => t.repo === APP);
  check("a first run reaches GitHub, with a .github/workflows file", r.status === 200 && !!first, first ? `${Date.now() - t0} ms` : `${row?.state}: ${row?.problem?.message ?? ""}`);

  // 2. A merge, timed.
  let sha = await merge();
  const t1 = Date.now();
  const m1 = await waitFor(async () => (await refs())["refs/heads/main"] === sha, 60_000);
  check("a merge reaches GitHub", !!m1, `${Date.now() - t1} ms after the merge answered (spacing 10 s)`);

  // 3. Whole repository mode into the same test repository (main is overwritten with the composed history), with a large file outside projects/.
  const big = randomBytes(2 * 1024 * 1024);
  const oid = createHash("sha256").update(big).digest("hex");
  const put = await fetch(`${URL_}/v1/monorepos/${O}/${M}/meta/blobs/${oid}`, { method: "PUT", headers: { authorization: `Bearer ${S}`, "content-length": String(big.length) }, body: big });
  const ws = new WebSocket(`${URL_.replace(/^http/, "ws")}/v1/monorepos/${O}/${M}/meta/socket`, { headers: { authorization: `Bearer ${S}` } });
  const frames = [];
  ws.onmessage = (m) => frames.push(JSON.parse(m.data));
  await waitFor(() => ws.readyState === 1, 10_000);
  ws.send(JSON.stringify({ type: "hello", since: 0, machine: "mg-mbp", agent: null, client: "mirror-github-test/1" }));
  await waitFor(() => frames.find((f) => f.type === "caught_up"), 10_000);
  const pointer = Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${big.length}\n`);
  const blobSha = createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${pointer.length}\0`), pointer])).digest("hex");
  ws.send(JSON.stringify({ type: "save", id: "s1", path: "art/big.bin", base_version: 0, sha: blobSha, bytes: pointer.toString("base64") }));
  const committed = await waitFor(async () => (await call("GET", `/v1/monorepos/${O}/${M}/meta/status`, S)).json?.last_commit ?? null, 60_000);
  r = await call("PUT", `/v1/monorepos/${O}/${M}/mirror/targets`, S, { mode: "whole", targets: [{ repo: "*", github_id: gh.id, on: true }] });

  const whole = await waitFor(async () => {
    const x = await refs();

    return x[`refs/pando/${APP}`] === sha && x["refs/pando/meta"] === committed && x["refs/heads/main"] !== sha ? x : null;
  }, 120_000);

  const wrow = (await call("GET", `/v1/monorepos/${O}/${M}/mirror`, S)).json?.targets?.[0];
  check("whole repository: GitHub accepts the hidden refs and a composed main, the large file through GitHub's LFS", put.ok && !!committed && !!whole && wrow?.state === "up_to_date", whole ? "" : `${wrow?.state}: ${wrow?.problem?.message ?? ""}`);
  ws.close();
} catch (err) {
  check("no exception", false, String(err?.stack ?? err).slice(0, 600));
} finally {
  await tw.cleanup();

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
