// gitwrite against real Artifacts, checked with the real git client.
//
//   cd worker && node src/gitwrite/harness/run.mjs
//
// Starts the harness Worker under `wrangler dev` (Artifacts binding on the
// remote pando-spike namespace), makes gw-test-* repos, pushes with git,
// calls mergeCommit and commitChanges, clones the results with git, checks
// parents, trees and `git fsck --full --strict`, then deletes the repos.
// Set GW_HARNESS_URL to use a harness that is already running.
// Write tokens stay in this process's memory and the git child environment;
// they are never printed.
import { execFileSync, spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const workerDir = join(here, "..", "..", "..");

const PORT = 8799;

let BASE = process.env.GW_HARNESS_URL;

let dev = null;

const created = [];

const tokens = new Map(); // repo name -> token, memory only

let passed = 0;

let failed = 0;

function check(label, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}

// node:http with no keep-alive: fetch reuses idle sockets that wrangler dev
// has closed while a long git push ran.
function api(path, body) {
  return new Promise((resolve, reject) => {
    const req = request(`${BASE}${path}`, { method: "POST", agent: false }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch {
          reject(new Error(`${path}: ${res.statusCode} ${data.slice(0, 300)}`));
        }
      });
    });

    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function gitEnv(name) {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${tokens.get(name)}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(name, cwd, ...args) {
  const base = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.fileMode=true"];

  return execFileSync("git", [...base, ...args], { cwd, env: gitEnv(name), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(dir, files) {
  for (const [p, content] of Object.entries(files)) {
    const full = join(dir, p);

    if (content === null) {
      rmSync(full, { force: true });
      continue;
    }

    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

async function newRepo(kind) {
  const name = `gw-test-${kind}-${Math.random().toString(36).slice(2, 8)}`;
  const r = await api("/create", { name });

  if (r.status !== 200) throw new Error(`create ${name}: ${JSON.stringify(r.json)}`);
  created.push(name);
  const t = await api("/token", { name });
  tokens.set(name, t.json.token);
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  git(name, dir, "init", "-q", "-b", "main");
  git(name, dir, "remote", "add", "origin", r.json.remote);

  return { name, remote: r.json.remote, dir };
}

function commitAll(repo, message) {
  git(repo.name, repo.dir, "add", "-A");
  git(repo.name, repo.dir, "commit", "-q", "-m", message);

  return git(repo.name, repo.dir, "rev-parse", "HEAD");
}

function cloneFresh(repo) {
  const dir = mkdtempSync(join(tmpdir(), `${repo.name}-clone-`));
  git(repo.name, dir, "clone", "-q", repo.remote, ".");

  return dir;
}

function fsckOk(repo, dir) {
  try {
    git(repo.name, dir, "fsck", "--full", "--strict", "--no-dangling");

    return true;
  } catch (e) {
    console.log(String(e.stderr || e.message));

    return false;
  }
}

// What git itself would produce for the same merge, as a tree sha.
function gitMergeTree(repo, ours, theirs) {
  git(repo.name, repo.dir, "checkout", "-q", "--detach", ours);
  git(repo.name, repo.dir, "merge", "-q", "--no-ff", "--no-edit", theirs);
  const tree = git(repo.name, repo.dir, "rev-parse", "HEAD^{tree}");
  git(repo.name, repo.dir, "checkout", "-q", "main");

  return tree;
}

const AUTHOR = { name: "Ana Reviewer", email: "ana@example.com", date: "2026-10-01T12:00:00Z" };

const PANDO = { name: "Pando", email: "pando@example.com" };

async function testMerge() {
  console.log("\n== mergeCommit");
  const repo = await newRepo("merge");
  const { name, dir } = repo;
  write(dir, {
    "README.md": "# test\n",
    "a/one.txt": "one\n",
    "a/two.txt": "two\n",
    "b/three.txt": "three\n",
    "c/keep.txt": "keep\n",
    "c/del.txt": "del\n",
    "d/same.txt": "same-old\n",
    "e/mode.sh": "echo mode\n",
    "deep/x/y/z.txt": "z\n",
    "f/gone/f1.txt": "f1\n",
  });
  const base = commitAll(repo, "base");
  git(name, dir, "push", "-q", "origin", "main");

  // The branch.
  git(name, dir, "checkout", "-q", "-b", "agent/test/feature");
  write(dir, {
    "a/one.txt": "one feature\n",
    "a/new.txt": "new\n",
    "c/del.txt": null,
    "d/same.txt": "same-new\n",
    "newdir/n.txt": "n\n",
    "deep/x/y/z.txt": "z feature\n",
    "both/dir/t.txt": "t\n",
  });
  chmodSync(join(dir, "e/mode.sh"), 0o755);
  const head = commitAll(repo, "feature work");
  git(name, dir, "push", "-q", "origin", "agent/test/feature");

  // main moves.
  git(name, dir, "checkout", "-q", "main");
  write(dir, {
    "b/three.txt": "three main\n",
    "d/same.txt": "same-new\n",
    "e/mode.sh": "echo mode main\n",
    "both/dir/o.txt": "o\n",
    "f/gone/f1.txt": null,
  });
  const main1 = commitAll(repo, "main moves");
  git(name, dir, "push", "-q", "origin", "main");
  const expected = gitMergeTree(repo, main1, head);

  const msg = "Merge agent/test/feature\n\nThe review title and description.\n";
  let r = await api("/merge", { name, opts: { base: "main", head: "agent/test/feature", baseSha: main1, message: msg, author: AUTHOR, committer: PANDO, dryRun: true } });
  check("dry run says mergeable with git's tree", r.json.status === "mergeable" && r.json.tree === expected, `${r.json.status} tree=${r.json.tree}`);
  check("dry run found the merge base", r.json.mergeBase === base);

  const t0 = Date.now();
  r = await api("/merge", { name, opts: { base: "main", head: "agent/test/feature", baseSha: main1, message: msg, author: AUTHOR, committer: PANDO } });
  const ms = Date.now() - t0;
  check("mergeCommit merged", r.json.status === "merged", `${JSON.stringify(r.json)} in ${ms} ms`);
  const merged = r.json.sha;

  const c = cloneFresh(repo);
  check("main is the merge commit", git(name, c, "rev-parse", "main") === merged);
  check("parent 1 is main's old head", git(name, c, "rev-parse", "main^1") === main1);
  check("parent 2 is the branch head", git(name, c, "rev-parse", "main^2") === head);
  check("merged tree equals git's own merge", git(name, c, "rev-parse", "main^{tree}") === expected);
  check("git fsck --full --strict is clean", fsckOk(repo, c));
  const meta = git(name, c, "log", "-1", "--format=%an|%ae|%at|%cn|%ce|%s|%b", "main");
  check("author, committer and message kept", meta === `Ana Reviewer|ana@example.com|${Date.parse(AUTHOR.date) / 1000}|Pando|pando@example.com|Merge agent/test/feature|The review title and description.`, meta);
  check("mode from the branch and content from main both landed",
    git(name, c, "ls-tree", "main", "e/mode.sh").startsWith("100755") && readFileSync(join(c, "e/mode.sh"), "utf8") === "echo mode main\n");
  check("a directory emptied on main is gone", git(name, c, "ls-tree", "main", "f") === "");

  r = await api("/merge", { name, opts: { base: "main", head: "agent/test/feature", message: msg, author: AUTHOR } });
  check("merging again is up_to_date", r.json.status === "up_to_date" && r.json.sha === merged, r.json.status);

  r = await api("/merge", { name, opts: { base: "main", head: "agent/test/feature", baseSha: main1, message: msg, author: AUTHOR } });
  check("a stale baseSha is ref_moved", r.json.status === "ref_moved" && r.json.actual === merged, JSON.stringify(r.json));

  // Artifacts itself refuses a ref update with a stale old sha.
  r = await api("/raw-push", { name, ref: "refs/heads/main", old: main1, new: head });
  check("Artifacts refuses a push with a stale old sha", typeof r.json.refused === "string", `refused: ${r.json.refused}`);
  check("main did not move", git(name, c, "ls-remote", "origin", "refs/heads/main").startsWith(merged));

  // Conflicts.
  console.log("\n== conflicts");
  git(name, dir, "fetch", "-q", "origin");
  git(name, dir, "checkout", "-q", "-B", "main", "origin/main");
  git(name, dir, "checkout", "-q", "-b", "agent/test/conflict");
  write(dir, { "README.md": "# conflict branch\n", "b/three.txt": "three branch\n", "a/two.txt": "two branch\n" });
  commitAll(repo, "branch edits");
  git(name, dir, "push", "-q", "origin", "agent/test/conflict");
  git(name, dir, "checkout", "-q", "main");
  write(dir, { "README.md": "# conflict main\n", "b/three.txt": null });
  const main2 = commitAll(repo, "main edits");
  git(name, dir, "push", "-q", "origin", "main");
  r = await api("/merge", { name, opts: { base: "main", head: "agent/test/conflict", message: "Merge conflict", author: AUTHOR } });
  check("both sides edited README.md, main deleted b/three.txt: conflict",
    r.json.status === "conflict" && JSON.stringify(r.json.paths) === JSON.stringify(["README.md", "b/three.txt"]), JSON.stringify(r.json.paths));
  check("nothing written on a conflict", git(name, c, "ls-remote", "origin", "refs/heads/main").startsWith(main2));

  // The fix the contract names: merge main into the branch, push, merge again.
  console.log("\n== conflict fixed on the branch");
  git(name, dir, "checkout", "-q", "agent/test/conflict");

  try {
    git(name, dir, "merge", "-q", "--no-edit", "main");
  } catch {
    // README.md and b/three.txt conflict, as expected
  }

  write(dir, { "README.md": "# resolved\n", "b/three.txt": "three branch\n" });
  git(name, dir, "add", "-A");
  git(name, dir, "commit", "-q", "--no-edit");
  const fixed = git(name, dir, "rev-parse", "HEAD");
  git(name, dir, "push", "-q", "origin", "agent/test/conflict");
  git(name, dir, "checkout", "-q", "main");
  const expectedFixed = gitMergeTree(repo, main2, fixed);
  r = await api("/merge", { name, opts: { base: "main", head: "agent/test/conflict", message: "Merge agent/test/conflict", author: AUTHOR } });
  check("merges once main is merged into the branch", r.json.status === "merged" && r.json.mergeBase === main2, `${r.json.status} base=${r.json.mergeBase}`);
  const main3 = r.json.sha;
  git(name, c, "fetch", "-q", "origin");
  check("tree equals git's own merge", git(name, c, "rev-parse", "origin/main^{tree}") === expectedFixed);
  check("fsck", fsckOk(repo, c));

  // main has not moved since the branch: still a merge commit.
  console.log("\n== main has not moved");
  git(name, dir, "fetch", "-q", "origin");
  git(name, dir, "checkout", "-q", "-B", "main", "origin/main");
  git(name, dir, "checkout", "-q", "-b", "agent/test/ff");
  write(dir, { "ff/new.txt": "ff\n" });
  const ffHead = commitAll(repo, "ff work");
  git(name, dir, "push", "-q", "origin", "agent/test/ff");
  r = await api("/merge", { name, opts: { base: "main", head: ffHead, message: "Merge agent/test/ff", author: AUTHOR } });
  check("merged by sha", r.json.status === "merged", JSON.stringify(r.json.status));
  git(name, c, "fetch", "-q", "origin");
  check("two parents even when main had not moved",
    git(name, c, "rev-parse", "origin/main^1") === main3 && git(name, c, "rev-parse", "origin/main^2") === ffHead);
  check("tree is the branch's tree", git(name, c, "rev-parse", "origin/main^{tree}") === git(name, c, "rev-parse", `${ffHead}^{tree}`));
  check("fsck after the second merge", fsckOk(repo, c));

  r = await api("/merge", { name, opts: { base: "main", head: "agent/test/nope", message: "x", author: AUTHOR } });
  check("an unknown branch is not_found", r.status === 400 && r.json.error === "not_found", r.json.error);
}

async function testWide() {
  console.log("\n== a wide repo: reads follow the changed paths");
  const repo = await newRepo("wide");
  const { name, dir } = repo;
  const files = {};

  for (let p = 0; p < 300; p++) for (let f = 0; f < 10; f++) files[`pkg-${String(p).padStart(3, "0")}/src/f${f}.txt`] = `${p}.${f}\n`;
  write(dir, files);
  commitAll(repo, "3000 files");
  git(name, dir, "push", "-q", "origin", "main");
  git(name, dir, "checkout", "-q", "-b", "agent/test/wide");
  write(dir, { "pkg-010/src/f1.txt": "branch\n", "pkg-020/src/f2.txt": "branch\n" });
  const head = commitAll(repo, "branch");
  git(name, dir, "push", "-q", "origin", "agent/test/wide");
  git(name, dir, "checkout", "-q", "main");
  write(dir, { "pkg-010/src/f3.txt": "main\n", "pkg-250/src/f4.txt": "main\n" });
  const main1 = commitAll(repo, "main");
  git(name, dir, "push", "-q", "origin", "main");
  const expected = gitMergeTree(repo, main1, head);
  const t0 = Date.now();
  const r = await api("/merge", { name, opts: { base: "main", head: "agent/test/wide", message: "Merge wide", author: AUTHOR } });
  const ms = Date.now() - t0;
  check("merged", r.json.status === "merged", `${ms} ms, stats ${JSON.stringify(r.json.stats)}`);
  check("only root, pkg-010 and pkg-010/src were read (9 trees of 3,000 files)", r.json.stats?.treesRead === 9, `treesRead=${r.json.stats?.treesRead}`);
  const c = cloneFresh(repo);
  check("tree equals git's own merge", git(name, c, "rev-parse", "main^{tree}") === expected);
  check("fsck", fsckOk(repo, c));
}

async function testCommit() {
  console.log("\n== commitChanges");
  const repo = await newRepo("commit");
  const { name } = repo;
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

  let r = await api("/commit", {
    name,
    branch: "main",
    opts: {
      parent: null,
      changes: [
        { path: "README.md", content: "# meta\n" },
        { path: "docs/a.md", content: "a\n" },
        { path: "scripts/run.sh", content: "#!/bin/sh\necho run\n", mode: "100755" },
        { path: "tools/x.sh", content: "echo x\n", mode: "100755" },
        { path: "link", content: "README.md", mode: "120000" },
        { path: "bin/data.bin", base64: bytes.toString("base64") },
      ],
      message: "Save six files",
      author: AUTHOR,
    },
  });

  check("root commit on an empty repo", r.json.status === "committed", JSON.stringify(r.json));
  const sha1 = r.json.sha;
  const c = cloneFresh(repo);
  check("clone has the commit, no parents", git(name, c, "rev-parse", "main") === sha1 && git(name, c, "rev-list", "--parents", "-n1", "main") === sha1);
  const tree = git(name, c, "ls-tree", "-r", "main");
  check("modes: file, executable, symlink", /100755 blob \S+\tscripts\/run\.sh/.test(tree) && /120000 blob \S+\tlink/.test(tree) && /100644 blob \S+\tREADME\.md/.test(tree), "");
  check("binary content round-trips", readFileSync(join(c, "bin/data.bin")).equals(bytes));
  check("fsck", fsckOk(repo, c));

  r = await api("/commit", {
    name,
    branch: "main",
    opts: {
      parent: sha1,
      changes: [
        { path: "docs/a.md", content: "a, edited\n" },
        { path: "scripts/run.sh", delete: true },
        { path: "docs/sub/new.md", content: "new\n" },
        { path: "tools/x.sh", content: "echo x2\n" },
        { path: "nope/missing.txt", delete: true },
      ],
      message: "Save docs",
      author: AUTHOR,
      committer: PANDO,
    },
  });
  check("second commit", r.json.status === "committed", JSON.stringify(r.json));
  const sha2 = r.json.sha;
  git(name, c, "pull", "-q", "--ff-only", "origin", "main");
  check("parent is the first commit", git(name, c, "rev-parse", "main^") === sha1);
  check("edit, add, delete applied", readFileSync(join(c, "docs/a.md"), "utf8") === "a, edited\n" &&
    readFileSync(join(c, "docs/sub/new.md"), "utf8") === "new\n" && git(name, c, "ls-tree", "main", "scripts") === "");
  check("an existing executable keeps its mode", git(name, c, "ls-tree", "main", "tools/x.sh").startsWith("100755"));
  check("committer kept", git(name, c, "log", "-1", "--format=%an|%cn", "main") === "Ana Reviewer|Pando");
  check("fsck", fsckOk(repo, c));

  r = await api("/commit", { name, branch: "main", opts: { parent: sha2, changes: [{ path: "docs/a.md", content: "a, edited\n" }], message: "same", author: AUTHOR } });
  check("same content is unchanged, nothing written", r.json.status === "unchanged" && r.json.sha === sha2, r.json.status);

  r = await api("/commit", { name, branch: "main", opts: { parent: sha1, changes: [{ path: "x.md", content: "x\n" }], message: "stale", author: AUTHOR } });
  check("a stale parent is ref_moved", r.json.status === "ref_moved" && r.json.actual === sha2, JSON.stringify(r.json));

  r = await api("/commit", { name, branch: "main", opts: { parent: sha2, changes: [{ path: "../x", content: "x" }], message: "bad", author: AUTHOR } });
  check("a bad path is invalid_input", r.status === 400 && r.json.error === "invalid_input", r.json.message);
  r = await api("/commit", { name, branch: "main", opts: { parent: sha2, changes: [{ path: "docs", content: "x" }], message: "bad", author: AUTHOR } });
  check("a file over a directory is invalid_input", r.status === 400 && r.json.error === "invalid_input", r.json.message);

  r = await api("/commit", { name, branch: "meta/saves", opts: { parent: sha2, changes: [{ path: "notes.md", content: "n\n" }], message: "new branch", author: AUTHOR } });
  check("a new branch on top of a parent", r.json.status === "committed", r.json.status);
  git(name, c, "fetch", "-q", "origin");
  check("the new branch's parent is main", git(name, c, "rev-parse", "origin/meta/saves^") === sha2);
  check("fsck", fsckOk(repo, c));

  r = await api("/tokens", { name });
  check("gitwrite revoked its write tokens", r.json.total === 1, `active tokens: ${r.json.total} (1 is the test's own)`);
}

async function startHarness() {
  if (BASE) return;
  BASE = `http://localhost:${PORT}`;
  dev = spawn("npx", ["wrangler", "dev", "-c", join(here, "wrangler.jsonc"), "--port", String(PORT)], {
    cwd: workerDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`wrangler dev did not start:\n${log}`)), 90_000);

    const on = (d) => {
      log += d;

      if (log.includes("Ready on")) {
        clearTimeout(t);
        resolve();
      }
    };

    dev.stdout.on("data", on);
    dev.stderr.on("data", on);
    dev.on("exit", (code) => reject(new Error(`wrangler dev exited ${code}:\n${log}`)));
  });
}

try {
  await startHarness();
  await testMerge();
  await testWide();
  await testCommit();
} catch (e) {
  failed++;
  console.log(`FAIL  ${e.stack || e}`);
} finally {
  for (const name of created) {
    const r = await api("/delete", { name }).catch((e) => ({ json: { error: String(e) } }));
    console.log(`deleted ${name}: ${JSON.stringify(r.json)}`);
  }

  if (dev) dev.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
