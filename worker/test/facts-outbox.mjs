// Branch facts through the monorepo object's outbox (C25-LIVE-HOME.md step 2):
// a push's facts are stored within seconds with no queue in the path; a failed
// drain is tried again on the retry delays; a job that keeps failing is kept
// as dead.
//
//   npx wrangler dev --port 8797 --var FACTS_TEST:1 --var FACTS_RETRY_MS:300,300
//   PANDO_URL=http://localhost:8797 node test/facts-outbox.mjs
//   PANDO_URL=https://pando-dev... USE_HOME_CRED=1 node test/facts-outbox.mjs   (the latency part only)
//
// Credentials stay in memory; git never reaches the keychain; it deletes its
// monorepo.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch, throwaways } from "./errors.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");
const HOME_CRED = !!process.env.USE_HOME_CRED;
const BOOT = HOME_CRED ? null : (process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1]);
const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`.replace(/pando_[a-f0-9]{20,}/g, "<credential>"));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let S = null;
const call = async (method, path, body, secret = S) => {
  const res = await fetch(URL_ + path, { method, headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const work = mkdtempSync(join(tmpdir(), "pando-fo-"));
const git = (args, cwd) => {
  const r = spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S ?? "", GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" },
  });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
};

const id = Date.now().toString(36);
const M = `fo-${id}`;
let O = null;
let made = false;
const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`)).status);
try {
  if (HOME_CRED) {
    S = readFileSync(join(homedir(), ".pando/credentials", new URL(URL_).host), "utf8").trim();
    O = (await call("GET", "/v1/user")).json?.login;
  } else {
    O = `fo-${id}`;
    S = (await call("POST", "/v1/users", { login: O }, BOOT)).json?.credential?.secret;
  }
  const r = await call("POST", "/v1/monorepos", { name: M, kind: "repo" });
  made = r.status === 201;
  if (made) tw.add(`${O}/${M}`);
  const MID = r.json?.monorepo?.id;
  const url = r.json?.repos?.[0]?.clone_url;
  const base = `/v1/monorepos/${O}/${M}/repos/${M}`;
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "a.txt"), "a\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  check("push main", git(["push", "-q", url, "main"], src).ok);

  // The facts of a pushed branch, from the stored rows (no inline compute): how soon after the push.
  const stored = async (branch, within) => {
    const t0 = Date.now();
    while (Date.now() - t0 < within) {
      const l = await call("GET", `${base}/branches?state=open`);
      const b = l.json?.branches?.find((x) => x.name === branch);
      if (b && b.mergeable && b.mergeable !== "pending" && b.ahead !== null) return { ms: Date.now() - t0, b };
      await sleep(100);
    }
    return null;
  };
  const pushBranch = (name) => {
    git(["checkout", "-qb", name, "main"], src);
    writeFileSync(join(src, `${name}.txt`), `${name}\n`);
    git(["add", "-A"], src);
    git(["commit", "-qm", name], src);
    return git(["push", "-q", url, name], src).ok;
  };
  const times = [];
  for (let i = 0; i < 5; i++) {
    const name = `fast-${i}`;
    pushBranch(name);
    const got = await stored(name, 20_000);
    times.push(got?.ms ?? null);
  }
  const ok = times.every((t) => t !== null);
  const sorted = times.filter((t) => t !== null).sort((a, b) => a - b);
  check("each pushed branch's facts are stored, no queue in the path", ok && sorted[sorted.length - 1] < 5000, `ms after the push returned: ${times.join(", ")}`);

  if (!HOME_CRED) {
    const t = await call("GET", `/v1/_facts/test?monorepo=${MID}`, null, BOOT);
    if (t.status === 404) console.log("SKIP  retries (start the server with --var FACTS_TEST:1 --var FACTS_RETRY_MS:300,300)");
    else {
      check("the outbox is empty once the facts are stored", t.json?.live === 0, JSON.stringify(t.json));
      // One failed drain: the job is retried on the alarm and its facts arrive.
      await call("POST", "/v1/_facts/test", { monorepo: MID, fail: 1 }, BOOT);
      pushBranch("retry-1");
      await sleep(300);
      const mid = await call("GET", `/v1/_facts/test?monorepo=${MID}`, null, BOOT);
      check("a failed drain leaves the job in the outbox with its error", mid.json?.rows?.some((r) => r.attempts === 1 && /failed drain/.test(r.error ?? "")), JSON.stringify(mid.json?.rows));
      const got = await stored("retry-1", 15_000);
      check("and the retry stores its facts", !!got, `${got?.ms ?? "never"} ms`);
      const after = await call("GET", `/v1/_facts/test?monorepo=${MID}`, null, BOOT);
      check("then the outbox is empty", after.json?.live === 0 && after.json?.dead === 0, JSON.stringify(after.json));
      // Always failing: dead after the last retry, kept.
      await call("POST", "/v1/_facts/test", { monorepo: MID, fail: 10 }, BOOT);
      pushBranch("dead-1");
      let dead = null;
      for (let i = 0; i < 40 && !dead; i++) {
        await sleep(250);
        const s = await call("GET", `/v1/_facts/test?monorepo=${MID}`, null, BOOT);
        if (s.json?.dead >= 1) dead = s.json;
      }
      check("a job that keeps failing is kept as dead after the last retry", !!dead && dead.rows.some((r) => r.dead_at && r.attempts === 3), JSON.stringify(dead?.rows));
      await call("POST", "/v1/_facts/test", { monorepo: MID, fail: 0 }, BOOT);
    }
  }
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  if (made) check(`delete ${O}/${M}`, await tw.cleanup());
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
