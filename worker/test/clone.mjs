// pando clone and pando worktree add on the default driver, a git clone,
// end to end against `wrangler dev`: the real pando binary (go build), a
// monorepo made with `pando init` (real git through the door, real
// Artifacts), and the kind left to pando's default (no --kind, no
// PANDO_WORKTREE_KIND).
//
//   - projects/app holds several hundred files in nested folders (or, with
//     --from, a real repo's main branch);
//   - pando clone makes its read-only main and worktree add a branch: each
//     says "sparse worktree, ready in N s", leaves every working file on
//     disk, and git's requests to the door for it stay few (counted with
//     GIT_TRACE_CURL), however many files there are;
//   - after that, git status and a whole-tree search make no request;
//   - a worktree with named folders has only those folders and the
//     top-level files;
//   - a reference is not cloned by pando clone; pando reference sync clones
//     it, read-only, at its pinned commit;
//   - worktree list and remove.
//
//   PANDO_URL=http://localhost:8879 node test/clone.mjs [--from <git repo>] [--files N]
//
// Reads PANDO_BOOTSTRAP from worker/.dev.vars. Credentials are never
// printed. Every pando and git run has HOME and PANDO_HOME in the test's
// folder and no system git config, so nothing reaches the owner's git
// config, ~/.pando or the keychain. It deletes the monorepo it makes.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeError, retryResetFetch } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8879").replace(/\/$/, "");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const arg = (name) => {
  const i = process.argv.indexOf(name);

  return i > 0 ? process.argv[i + 1] : undefined;
};

const FROM = arg("--from");

const FILES = Number(arg("--files") ?? 600);

// Requests one clone may make to the door, whatever its size: the ref
// listing and the fetch of commits and trees, then one batched fetch of the
// working files (each a git process's handshake and its request).
const MAX_REQUESTS = 8;

const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>").replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<token>");

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`));
};

const call = (method, path, secret, body) => request(URL_, method, path, { secret, body, headers: { connection: "close" } });

const id = Date.now().toString(36);

const work = mkdtempSync(join(tmpdir(), "pando-clone-"));

const SAFE = {
  HOME: join(work, "home"), XDG_CONFIG_HOME: join(work, "home", ".config"), PANDO_HOME: join(work, "pando-home"),
  GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", PANDO_SERVER: "", PANDO_TOKEN: "", PANDO_AGENT: "", PANDO_NO_BROWSER: "1",
  PANDO_MACHINE: "clone-box", PANDO_WORKTREE_KIND: "", PANDO_AGENT_CONTAINER: "",
  GIT_AUTHOR_NAME: "Clone Person", GIT_AUTHOR_EMAIL: "clone@pando.invalid", GIT_COMMITTER_NAME: "Clone Person", GIT_COMMITTER_EMAIL: "clone@pando.invalid",
};

mkdirSync(SAFE.HOME);

const bin = join(work, "pando");

/** One run of the built pando: exit status, stdout, stderr and how long it took. */
const pando = (args, o = {}) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(bin, args, { cwd: o.cwd ?? work, env: { ...process.env, ...SAFE, CLONE_TEST_SECRET: S ?? "", ...o.env } });
    const out = { status: null, stdout: "", stderr: "" };
    child.stdout.on("data", (d) => (out.stdout += d));
    child.stderr.on("data", (d) => (out.stderr += d));
    child.on("close", (code) => resolve({ ...out, status: code, ms: Date.now() - t0 }));
    child.on("error", (err) => resolve({ ...out, status: -1, stderr: out.stderr + String(err.message), ms: Date.now() - t0 }));
    child.stdin.end(o.input ?? "");
  });

const git = (args, cwd, env = {}) => spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env: { ...process.env, ...SAFE, CLONE_TEST_SECRET: S ?? "", ...env }, encoding: "utf8", maxBuffer: 1 << 28 });

const said = (run) => scrub(`${run.status} ${run.stdout} ${run.stderr}`).trim().slice(0, 400);

/** The HTTP requests git sent for the repo at `path`, from a GIT_TRACE_CURL file. */
const requestsFor = (trace, path) => {
  let text = "";

  try {
    text = readFileSync(trace, "utf8");
  } catch {}

  return text.split("\n").filter((l) => /=> Send header: (GET|POST) /.test(l) && l.includes(path)).length;
};

/** Every file under dir, .git and worktrees/ left out, as paths from dir. */
function filesOnDisk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || (dir === base && e.name === "worktrees")) continue;

    const p = join(dir, e.name);

    if (e.isDirectory()) filesOnDisk(p, base, out);
    else out.push(p.slice(base.length + 1));
  }

  return out;
}

/** The checkout at dir has every file of HEAD's tree on disk and in the object store. */
function wholeTree(dir) {
  const listed = git(["ls-files"], dir).stdout.split("\n").filter(Boolean);
  const disk = new Set(filesOnDisk(dir));
  const missingOnDisk = listed.filter((f) => !disk.has(f));
  const missingObjects = git(["rev-list", "--objects", "--missing=print", "HEAD^{tree}"], dir).stdout.split("\n").filter((l) => l.startsWith("?"));

  return { listed: listed.length, missingOnDisk: missingOnDisk.length, missingObjects: missingObjects.length };
}

/** n files in nested folders: a few levels deep, text of a few hundred bytes. */
function writeFiles(dir, n) {
  for (let i = 0; i < n; i++) {
    const folder = join(dir, `pkg-${i % 12}`, `mod-${i % 7}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `file-${i}.ts`), `export const value${i} = ${i};\n// ${"x".repeat(200 + (i % 300))}\n`);
  }

  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n");
  writeFileSync(join(dir, "README.md"), "# app\n");
}

let S = null;

let full = null;

let libFull = null;

try {
  S = (await call("POST", "/v1/users", BOOT, { login: `clone-${id}`, credential_name: "clone-box" })).json?.credential?.secret;
  check("a user to sign in as", !!S);
  const cli = fileURLToPath(new URL("../../cli", import.meta.url));
  const built = spawnSync("go", ["build", "-buildvcs=false", "-o", bin, "./cmd/pando"], { cwd: cli, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  check("the cli builds", built.status === 0, built.stderr?.slice(0, 200));
  let r = await pando(["login", "--server", URL_, "--with-credential"], { input: S + "\n" });
  check("pando login --with-credential (piped)", r.status === 0, said(r));

  // The monorepo: projects/app, and research/lib a reference to a repo on this disk.
  const NAME = `clone-${id}`;
  const mono = join(work, NAME);
  const app = join(mono, "projects", "app");
  mkdirSync(join(mono, "projects"), { recursive: true });
  writeFileSync(join(mono, "AGENTS.md"), "notes\n");

  if (FROM) {
    const c = git(["clone", "-q", "--no-local", "--single-branch", FROM, app], work);
    check(`projects/app from ${FROM}`, c.status === 0, c.stderr?.slice(0, 200));
    git(["branch", "-m", "main"], app);
    git(["remote", "remove", "origin"], app);
  } else {
    mkdirSync(app);
    writeFiles(app, FILES);
    git(["init", "-q"], app);
    git(["add", "-A"], app);
    git(["commit", "-qm", "first"], app);
    writeFileSync(join(app, "pkg-0", "mod-0", "file-0.ts"), "export const value0 = 'second';\n");
    git(["commit", "-qam", "second"], app);
  }

  // research/lib: a reference whose upstream is a plain Pando repo, fetched
  // with this machine's own git access (a helper in the test's global git
  // config, as a person's would be).
  r = await call("POST", "/v1/monorepos", S, { name: `lib-${id}`, kind: "repo" });
  const libUrl = r.json?.repos?.[0]?.clone_url;
  libFull = r.status === 201 ? `${r.json.monorepo.owner}/lib-${id}` : null;
  check("an upstream for the reference: a plain repo", !!libUrl, String(r.status));
  writeFileSync(join(SAFE.HOME, ".gitconfig"), `[credential "${new URL(URL_).origin}"]\n\thelper = "!f() { echo username=x; echo password=$CLONE_TEST_SECRET; }; f"\n`);
  const lib = join(mono, "research", "lib");
  mkdirSync(lib, { recursive: true });
  writeFiles(lib, 30);
  git(["init", "-q"], lib);
  git(["add", "-A"], lib);
  git(["commit", "-qm", "lib"], lib);
  git(["remote", "add", "origin", libUrl], lib);
  const libSha = git(["rev-parse", "HEAD"], lib).stdout.trim();
  writeFileSync(join(lib, "later.md"), "a newer commit, not the pinned one\n");
  git(["add", "-A"], lib);
  git(["commit", "-qm", "later"], lib);
  const pushed = git(["push", "-q", "origin", "main"], lib);
  check("... holding two commits", pushed.status === 0, pushed.stderr?.slice(0, 200));
  git(["reset", "-q", "--hard", libSha], lib);

  const files = git(["ls-files"], app).stdout.split("\n").filter(Boolean).length;
  const commits = git(["rev-list", "--count", "HEAD"], app).stdout.trim();
  r = await pando(["init", "--yes", "--name", NAME], { cwd: mono });
  full = `clone-${id}/${NAME}`;
  check(`pando init pushes projects/app (${files} files, ${commits} commits) and the reference's pointer`, r.status === 0 && r.stdout.includes(`Pando monorepo ${full} is set up`), said(r));
  console.log(`      pando init: ${(r.ms / 1000).toFixed(1)} s`);
  const repos = (await call("GET", `/v1/monorepos/${full}/repos`, S)).json?.repos ?? [];
  const appPath = new URL(repos.find((x) => x.path === "projects/app")?.clone_url ?? URL_).pathname;

  // ── pando clone on a fresh folder: main is a clone with every file ──
  const trace = join(work, "clone.trace");
  const there = join(work, "there");
  r = await pando(["clone", full, there], { env: { GIT_TRACE_CURL: trace, GIT_TRACE_CURL_NO_DATA: "1" } });
  const mainDir = join(there, "projects", "app", "worktrees", "main");
  const ready = /projects\/app\/worktrees\/main: main \(main, read-only\), sparse worktree, ready in ([0-9.]+)s/.exec(r.stdout);
  check("pando clone: main is a clone by default, and says when it was ready", r.status === 0 && !!ready, said(r));
  check("... with no note about a mount", !/mount|Pando\.app|extension/i.test(r.stderr), r.stderr.slice(0, 200));
  let n = requestsFor(trace, appPath);
  let t = wholeTree(mainDir);
  check(`... every one of the ${t.listed} files is on disk, and no object of the tree is missing`, t.listed === files && t.missingOnDisk === 0 && t.missingObjects === 0, JSON.stringify(t));
  check(`... in at most ${MAX_REQUESTS} requests to the door for ${files} files`, n > 0 && n <= MAX_REQUESTS, `${n} requests`);
  console.log(`      pando clone: ${(r.ms / 1000).toFixed(1)} s in all, main ready in ${ready?.[1]} s, ${n} git requests for projects/app`);
  check("... and the reference is not cloned: pando clone says how to get it", /1 reference\(s\) not made here: pando reference sync/.test(r.stdout) && !statSync(join(there, "research", "lib"), { throwIfNoEntry: false })?.isDirectory?.(), said(r));

  // ── pando worktree add: a branch, every file on disk ──
  const trace2 = join(work, "add.trace");
  r = await pando(["worktree", "add", "projects/app", "feat"], { cwd: there, env: { GIT_TRACE_CURL: trace2, GIT_TRACE_CURL_NO_DATA: "1" } });
  const wt = join(there, "projects", "app", "worktrees", "feat");
  const ready2 = /sparse worktree, ready in ([0-9.]+)s/.exec(r.stdout);
  check("pando worktree add: a clone by default, ready in N s", r.status === 0 && !!ready2, said(r));
  n = requestsFor(trace2, appPath);
  t = wholeTree(wt);
  check(`... every one of the ${t.listed} files is on disk, and no object of the tree is missing`, t.listed === files && t.missingOnDisk === 0 && t.missingObjects === 0, JSON.stringify(t));
  check(`... in at most ${MAX_REQUESTS} requests to the door`, n > 0 && n <= MAX_REQUESTS, `${n} requests`);
  console.log(`      pando worktree add: ${(r.ms / 1000).toFixed(1)} s in all, ready in ${ready2?.[1]} s, ${n} git requests`);

  // ── after the clone, git works from the disk ──
  const trace3 = join(work, "after.trace");
  const env3 = { GIT_TRACE_CURL: trace3, GIT_TRACE_CURL_NO_DATA: "1" };
  let t0 = Date.now();
  const st = git(["status", "--porcelain"], wt, env3);
  const statusMs = Date.now() - t0;
  t0 = Date.now();
  const grep = git(["grep", "-c", "e", "HEAD"], wt, env3);
  const grepMs = Date.now() - t0;
  check("git status is clean, and it and a whole-tree search of HEAD make no request", st.status === 0 && st.stdout === "" && grep.status === 0 && requestsFor(trace3, "/") === 0, `${requestsFor(trace3, "/")} requests`);
  console.log(`      git status: ${statusMs} ms; git grep over HEAD: ${grepMs} ms`);

  // ── named folders only ──
  const folder = FROM ? git(["ls-tree", "-d", "--name-only", "HEAD"], app).stdout.split("\n")[0] : "docs";
  r = await pando(["worktree", "add", "projects/app", "one-folder", folder], { cwd: there });
  const only = join(there, "projects", "app", "worktrees", "one-folder");
  const onDisk = r.status === 0 ? filesOnDisk(only) : [];
  check(`worktree add with a folder named (${folder}): that folder and the top-level files only`, r.status === 0 && onDisk.some((f) => f.startsWith(`${folder}/`)) && onDisk.every((f) => !f.includes("/") || f.startsWith(`${folder}/`)), `${onDisk.length} files ${said(r)}`);

  // ── the reference, made when asked ──
  r = await pando(["status"], { cwd: there });
  check("pando status: the reference is not here, and how to get it", r.status === 0 && /research\/lib\s+main at \w+, not here \(pando reference sync clones it\)/.test(r.stdout), said(r));
  r = await pando(["reference", "sync"], { cwd: there });
  const ref = join(there, "research", "lib");
  const refHead = r.status === 0 ? git(["rev-parse", "HEAD"], ref).stdout.trim() : "";
  check("pando reference sync clones it at the pinned commit (not the newer one), sparse", r.status === 0 && /research\/lib: reference at \w+, read-only, sparse, ready in/.test(r.stdout) && refHead === libSha, said(r));
  t = r.status === 0 ? wholeTree(ref) : {};
  let readOnly = false;

  try {
    writeFileSync(join(ref, "README.md"), "edit");
  } catch {
    readOnly = true;
  }

  check("... every file on disk, and read-only", t.listed > 30 && t.missingOnDisk === 0 && t.missingObjects === 0 && readOnly, JSON.stringify(t));

  // ── list and remove ──
  r = await pando(["worktree", "list"], { cwd: there });
  check("pando worktree list: main, feat and one-folder, as sparse", r.status === 0 && ["main", "feat", "one-folder"].every((b) => new RegExp(`worktrees/${b}\\b`).test(r.stdout)) && /sparse/.test(r.stdout), said(r));
  r = await pando(["worktree", "remove", "projects/app/worktrees/feat"], { cwd: there });
  check("pando worktree remove: the folder is gone", r.status === 0 && !statSync(wt, { throwIfNoEntry: false }), said(r));
} catch (cause) {
  check("no exception", false, describeError(cause));
} finally {
  for (const name of [full, libFull].filter(Boolean)) {
    const r = await call("DELETE", `/v1/monorepos/${name}?confirm=${name}`, S);
    check(`delete ${name}`, r.status === 204, String(r.status));
  }

  spawnSync("chmod", ["-R", "u+w", work]);
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
