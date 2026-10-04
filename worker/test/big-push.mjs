// Pushes over the most one push carries (64 MiB, Artifacts' limit; door.ts
// PUSH_MAX), end to end against `wrangler dev` with DOOR_TEST=1:
//
//   - a plain git push over the limit is refused plainly, by its length or
//     as it streams, and nothing lands or is recorded;
//   - pando init brings in a history over the limit in steps (older
//     commits, then a commit too large for one push, as files sent ahead),
//     and leaves no side ref behind.
//
// The default run lowers the limit to 3 MiB for its pushes
// (X-Pando-Test-Push-Max, and PANDO_PUSH_LIMIT for pando), so it moves about
// 25 MB. `--big` (opt-in: slow, and it costs Artifacts operations) runs the
// same at the real 64 MiB, then times single pushes of 10, 24, 50, 80, 150
// and 500 MB (or the sizes after --big) and prints a row for each.
//
//   npx wrangler dev --port 8839 --persist-to <dir> --var DOOR_TEST:1
//   PANDO_URL=http://localhost:8839 node test/big-push.mjs [--big [MB ...]]
//
// Real git, the real pando binary (go build), real Artifacts. Credentials
// stay in memory and are never printed; git never reaches the keychain. It
// deletes every repository it makes.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeError, retryResetFetch, throwaways } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8839").replace(/\/$/, "");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const BIG = process.argv.includes("--big");

const SIZES = BIG ? process.argv.slice(process.argv.indexOf("--big") + 1).map(Number).filter(Boolean) : [];

const MIB = 1 << 20;

const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>").replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<artifacts-token>");

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`));
};

let S = null;

const call = (method, path, body) => request(URL_, method, path, { secret: S, body, headers: { connection: "close" } });

const work = mkdtempSync(join(tmpdir(), "pando-big-push-"));

const SAFE = {
  HOME: join(work, "home"), XDG_CONFIG_HOME: join(work, "home", ".config"), PANDO_HOME: join(work, "pando-home"),
  GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", PANDO_SERVER: "", PANDO_TOKEN: "", PANDO_AGENT: "", PANDO_NO_BROWSER: "1",
  PANDO_MACHINE: "big-box", PANDO_WORKTREE_KIND: "sparse",
  GIT_AUTHOR_NAME: "Big Push", GIT_AUTHOR_EMAIL: "big@pando.invalid", GIT_COMMITTER_NAME: "Big Push", GIT_COMMITTER_EMAIL: "big@pando.invalid",
};

mkdirSync(SAFE.HOME);

/** The door's limit for these pushes: lowered to `max` bytes by a test header, or the real one. */
const limitEnv = (max) =>
  max ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `X-Pando-Test-Push-Max: ${max}`, PANDO_PUSH_LIMIT: String(max) } : {};

const helper = ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f'];

/** git in the background (the Worker answers while it runs): exit status and output. */
const git = (args, cwd, env = {}) =>
  new Promise((resolve) => {
    const p = spawn("git", [...helper, "-c", "init.defaultBranch=main", ...args], { cwd, env: { ...process.env, ...SAFE, PANDO_SECRET: S ?? "", ...env } });
    let out = "";

    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ ok: code === 0, out: scrub(out) }));
  });

const bin = join(work, "pando");

const pando = (args, cwd, env = {}) =>
  new Promise((resolve) => {
    const p = spawn(bin, args, { cwd, env: { ...process.env, ...SAFE, ...env } });
    let out = "";

    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ ok: code === 0, out: scrub(out) }));
    p.stdin.end("");
  });

/** `files` random files of `each` bytes in `dir`, committed as one commit. */
async function commitRandom(dir, name, files, each) {
  for (let i = 0; i < files; i++) writeFileSync(join(dir, `${name}-${i}.bin`), randomBytes(each));
  await git(["add", "-A"], dir);
  await git(["commit", "-qm", name], dir);

  return (await git(["rev-parse", "HEAD"], dir)).out.trim();
}

async function newRepo(dir) {
  mkdirSync(dir);
  await git(["init", "-q"], dir);
}

/** The server's refs of a clone URL, as "sha ref" lines. */
const refsOf = async (url, cwd) => (await git(["ls-remote", url], cwd)).out;

const id = Date.now().toString(36);

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`)).status);

/** A plain repo made through the API: its clone URL and full name. */
async function plainRepo(name) {
  const r = await call("POST", "/v1/monorepos", { name, kind: "repo" });

  if (r.status !== 201) throw new Error(`making ${name}: ${r.status} ${r.text.slice(0, 200)}`);
  const full = `${r.json.monorepo.owner}/${name}`;
  tw.add(full);

  return { url: r.json.repos[0].clone_url, full, repo: r.json.repos[0].name };
}

const tail = (out) => out.split("\n").filter((l) => /Pando|rejected|error|fatal/.test(l)).slice(0, 4).join(" | ");

/**
 * A plain git push over `max` (the door's limit for it; null: the real one): refused with the limit named, by its
 * length (git's postBuffer over the pack) and as it streams (chunked), for main and for a branch; nothing lands.
 */
async function refusals(max, mb) {
  const limit = `${(max ?? 64 * MIB) / MIB} MiB`;
  const env = limitEnv(max);
  const { url, full, repo } = await plainRepo(`bp-${id}-${max ? "small" : "real"}`);
  const src = join(work, `refuse-${max ?? "real"}`);
  await newRepo(src);
  const head = await commitRandom(src, "big", Math.ceil(mb / 8), Math.round((mb * 1e6) / Math.ceil(mb / 8)));
  let g = await git(["-c", `http.postBuffer=${1 << 30}`, "push", url, "main"], src, env);
  check(`a plain push of main over ${limit}, with its length: refused, naming the limit and pando init`,
    !g.ok && g.out.includes(`this push is over ${limit}, the most one push can carry`) && g.out.includes("nothing landed") && g.out.includes("run pando init")
      && g.out.includes(`! [remote rejected] main -> main (over ${limit}; push in steps)`) && !/push again|Broken pipe/.test(g.out), tail(g.out));
  g = await git(["-c", "http.postBuffer=1048576", "push", url, "main"], src, env);
  check(`the same push streamed (chunked): refused the same way`, !g.ok && g.out.includes(`! [remote rejected] main -> main (over ${limit}; push in steps)`) && !/push again|Broken pipe/.test(g.out), tail(g.out));
  g = await git(["-c", "http.postBuffer=1048576", "push", url, `${head}:refs/heads/feature`], src, env);
  check(`a branch push over ${limit}, streamed: refused with how to push in steps`, !g.ok && g.out.includes("push it in steps, oldest commits first") && g.out.includes(`(over ${limit}; push in steps)`), tail(g.out));
  const refs = await refsOf(url, src);
  check("nothing landed at Artifacts", !/refs\/heads\//.test(refs), refs.trim() || "no refs");
  const r = await call("GET", `/v1/monorepos/${full}/repos/${repo}/branches?state=all`);
  check("and nothing was recorded", r.status === 200 && (r.json?.branches ?? []).length === 0, `${r.status} ${(r.json?.branches ?? []).length} branches`);
}

/** pando init on a plain repo whose history is over `max`: older commits in steps, one commit over the limit, then main. */
async function initInSteps(max, commits, each, large) {
  const limit = `${(max ?? 64 * MIB) / MIB} MiB`;
  const name = `bpi-${id}-${max ? "small" : "real"}`;
  const dir = join(work, name);
  await newRepo(dir);

  for (let i = 0; i < commits; i++) await commitRandom(dir, `c${i}`, 1, each);
  const head = await commitRandom(dir, "large", large.files, large.each);
  const t0 = Date.now();
  const r = await pando(["init", "--yes", "--name", name], dir, limitEnv(max));
  const ms = Date.now() - t0;
  const full = /Pando repo (\S+) is set up/.exec(r.out)?.[1];

  if (full) tw.add(full);
  check(`pando init brings in a history over ${limit} in steps`, r.ok && r.out.includes("pushing it in about") && r.out.includes("pushed a step") && r.out.includes("sending its files ahead of it"),
    `${(ms / 1000).toFixed(1)} s; ${r.out.split("\n").filter((l) => /step|ahead|pushed|pando:/.test(l)).length} lines; ${r.ok ? "" : r.out.slice(-300)}`);
  const url = full && (await call("GET", `/v1/monorepos/${full}/repos`)).json?.repos?.[0]?.clone_url;
  const refs = url ? await refsOf(url, dir) : "";
  check("main is the checkout's head, and no side ref is left", refs.includes(`${head}\trefs/heads/main`) && !refs.includes("refs/pando/"), refs.trim().split("\n").join(" | "));
  const clone = join(work, `${name}-clone`);
  const c = url ? await git(["clone", "-q", url, clone], work) : { ok: false, out: "no repo" };
  const fsck = c.ok ? await git(["fsck", "--strict"], clone) : c;
  check("a clone has the whole history, and fsck passes", c.ok && fsck.ok && (await git(["rev-list", "--count", "HEAD"], clone)).out.trim() === String(commits + 1), fsck.out.slice(-200));
}

/** One single push of `mb` MB of fresh random content to a new repo's main, timed. */
async function single(mb, k) {
  const { url } = await plainRepo(`bps-${id}-${k}`);
  const src = join(work, `single-${k}`);
  await newRepo(src);
  const head = await commitRandom(src, "blob", Math.ceil(mb / 8), Math.round((mb * 1e6) / Math.ceil(mb / 8)));
  const t0 = Date.now();
  const g = await git(["-c", `http.postBuffer=${1 << 30}`, "push", url, "main"], src);
  const ms = Date.now() - t0;
  const landed = (await refsOf(url, src)).includes(`${head}\trefs/heads/main`);
  console.log(JSON.stringify({ mb, push_ms: ms, exit: g.ok ? 0 : 1, landed, said: tail(g.out) }));
}

try {
  S = (await request(URL_, "POST", "/v1/users", { secret: BOOT, body: { login: `bp-${id}`, credential_name: "big-box" } })).json?.credential?.secret;
  check("a user to push as", !!S);
  const cli = fileURLToPath(new URL("../../cli", import.meta.url));
  const built = spawnSync("go", ["build", "-buildvcs=false", "-o", bin, "./cmd/pando"], { cwd: cli, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
  check("the cli builds", built.status === 0, built.stderr?.slice(0, 200));

  const login = await new Promise((resolve) => {
    const p = spawn(bin, ["login", "--server", URL_, "--with-credential"], { cwd: work, env: { ...process.env, ...SAFE } });
    p.on("close", (code) => resolve(code === 0));
    p.stdin.end(S + "\n");
  });

  check("pando login", login);

  // At 3 MiB: about 4 MB refused three times; a 10.5 MB history in steps.
  await refusals(3 * MIB, 4);
  await initInSteps(3 * MIB, 4, 1_500_000, { files: 5, each: 900_000 });

  if (BIG) {
    // At the real 64 MiB: 70 MB refused; a 150 MB history in steps, its last commit 80 MB.
    await refusals(null, 70);
    await initInSteps(null, 4, 16_000_000, { files: 10, each: 8_000_000 });

    for (const [k, mb] of (SIZES.length ? SIZES : [10, 24, 50, 80, 150, 500]).entries()) await single(mb, k);
  }
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  check("delete this run's repositories", await tw.cleanup());
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
