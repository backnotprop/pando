// A revert pushed through the door after a few pushes: Artifacts refused it with "stored delta chain contains a
// cycle" (research/operational/artifacts-delta-cycle-2026-10-04.md). git's thin pack sends the reverted-to tree
// as a delta against the current tree, which Artifacts holds as a delta against that same reverted-to tree.
// The door sends such a push again with those trees written whole.
//
//   npx wrangler dev --port 8797 --persist-to <dir>
//   PANDO_URL=http://localhost:8797 node test/revert-push.mjs
//
// The fewest steps: main with four files; on a branch, a commit adding a file, pushed, another, pushed; then
// `git revert HEAD`, pushed. Then a fresh clone checks every object, and the branch merges. Real git, real
// Artifacts. Credentials stay in memory; git never reaches the keychain. It deletes its repo.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`.replace(/pando_[a-f0-9]{20,}/g, "<credential>"));
};

const call = (method, path, secret, body) => request(URL_, method, path, { secret, body });

const work = mkdtempSync(join(tmpdir(), "pando-revert-push-"));

let S = null;

const git = (args, cwd) => {
  const r = spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S ?? "", GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" },
  });

  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.replace(/pando_[a-f0-9]+/g, "<credential>") };
};

const lastLines = (out) => out.split("\n").filter(Boolean).slice(-2).join(" | ");

const id = Date.now().toString(36);

const M = `revert-${id}`;

let O = null;

try {
  S = (await call("POST", "/v1/users", BOOT, { login: `revert-${id}` })).json?.credential?.secret;
  const r = await call("POST", "/v1/monorepos", S, { name: M, kind: "repo" });
  O = r.json?.monorepo?.owner ?? null;
  const url = r.json?.repos?.[0]?.clone_url;
  check("a plain repo", r.status === 201 && !!url, `${r.status}`);
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);

  // Four files make the root tree big enough for git to send the next trees as deltas.
  for (let i = 0; i < 4; i++) writeFileSync(join(src, `file-${i}.txt`), `file ${i}\n`);
  git(["add", "-A"], src);
  git(["commit", "-qm", "four files"], src);
  check("push main", git(["push", "-q", url, "main"], src).ok);

  git(["checkout", "-qb", "work"], src);

  const commitPush = (file) => {
    writeFileSync(join(src, file), `${file}\n`);
    git(["add", "-A"], src);
    git(["commit", "-qm", `add ${file}`], src);

    return git(["push", "-q", url, "work"], src);
  };

  check("push a commit adding a file (its tree goes as a delta against main's)", commitPush("add-0.txt").ok);
  const before = git(["rev-parse", "HEAD^{tree}"], src).out.trim();
  check("push another (its tree a delta against the first one's)", commitPush("add-1.txt").ok);

  git(["revert", "--no-edit", "HEAD"], src);
  const revert = git(["rev-parse", "HEAD"], src).out.trim();
  check("git revert HEAD brings back the first commit's tree", git(["rev-parse", "HEAD^{tree}"], src).out.trim() === before);
  const g = git(["push", url, "work"], src);
  check("the revert pushes", g.ok && !/delta chain/.test(g.out), g.ok ? "" : lastLines(g.out));
  const b = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/branches/work`, S);
  check("and its branch is recorded at the revert", b.status === 200 && b.json?.head === revert, `${b.status} ${b.json?.head?.slice(0, 7)}`);

  // Every object reads back whole: a fresh clone of every branch passes git fsck.
  const copy = join(work, "copy");
  const cl = git(["clone", "-q", "--mirror", url, copy], work);
  const fsck = git(["fsck", "--full", "--strict"], copy);
  check("a fresh clone passes git fsck --full --strict", cl.ok && fsck.ok, cl.ok ? lastLines(fsck.out) : lastLines(cl.out));
  check("with the branch at the revert", git(["rev-parse", "refs/heads/work"], copy).out.trim() === revert);

  const m = await call("POST", `/v1/monorepos/${O}/${M}/repos/${M}/branches/work/merge?force=0`, S, { expected_head: revert });
  const merged = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/branches/main`, S);
  git(["fetch", "-q", url, "main"], src);
  const mainTree = git(["rev-parse", "FETCH_HEAD^{tree}"], src).out.trim();
  check("the branch merges, and main's tree is the reverted one", m.status === 200 && mainTree === before, `${m.status} ${merged.json?.head?.slice(0, 7)}`);
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  if (O) {
    const r = await call("DELETE", `/v1/monorepos/${O}/${M}?confirm=${O}/${M}`, S);
    check(`delete ${O}/${M}`, r.status === 204, `${r.status}`);
  }

  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
