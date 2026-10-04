// Branch facts on change (the queue): list latency after merges, and the time
// until every open branch's mergeable is fresh again.
//
//   PANDO_URL=http://localhost:8797 N=20 node test/facts.mjs
//   PANDO_URL=https://pando-dev... USE_HOME_CRED=1 N=200 node test/facts.mjs
//
// N branches, one commit each, pushed in one git push. Then 3 merges, the list
// right after them, and polling until no row is stale. Credentials stay in
// memory; git never reaches the keychain; it deletes its monorepo.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch, throwaways } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");

const N = Number(process.env.N ?? 20);

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
};

const call = (method, path, secret, body) => request(URL_, method, path, { secret, body });

const work = mkdtempSync(join(tmpdir(), "pando-facts-"));

const id = Date.now().toString(36);

let S;

if (process.env.USE_HOME_CRED) S = readFileSync(join(homedir(), ".pando/credentials", new URL(URL_).host), "utf8").trim();
else {
  const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
  S = (await call("POST", "/v1/users", BOOT, { login: `facts-${id}` })).json?.credential?.secret;
}

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" };

const git = (a, cwd) => spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", "-c", "http.version=HTTP/1.1", ...a], { cwd, env, encoding: "utf8", maxBuffer: 1 << 26 });

const M = `facts-${id}`;

let O = null; // the owner (namespaces: owner/name), from the create answer

let made = false;

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, S)).status);

const list = (M2) => call("GET", `/v1/monorepos/${O}/${M2}/repos/${M2}/branches?state=open&limit=500`, S);

/** Poll until no open branch is stale; returns [ms, samples]. */
async function untilFresh(t0, maxMs) {
  const samples = [];

  while (Date.now() - t0 < maxMs) {
    let r;

    try {
      r = await list(M);
    } catch {
      samples.push(`${((Date.now() - t0) / 1000).toFixed(0)}s:dropped`);
      await new Promise((res) => setTimeout(res, 1000));
      continue;
    }

    const bs = r.json?.branches ?? [];
    const stale = bs.filter((b) => b.stale).length;
    samples.push(`${((Date.now() - t0) / 1000).toFixed(0)}s:${bs.length - stale}/${bs.length}`);

    if (bs.length && stale === 0) return [Date.now() - t0, samples];
    await new Promise((res) => setTimeout(res, 1000));
  }

  return [null, samples];
}

try {
  let r = await call("POST", "/v1/monorepos", S, { name: M, kind: "repo" });
  made = r.status === 201;
  O = r.json?.monorepo?.owner ?? null;

  if (made) tw.add(`${O}/${M}`);
  const url = r.json?.repos?.[0]?.clone_url;
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# facts\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  git(["push", "-q", url, "main"], src);
  // N branches, each with its own file, then one push of all of them.
  const main = git(["rev-parse", "HEAD"], src).stdout.trim();

  for (let i = 0; i < N; i++) {
    git(["checkout", "-q", main], src);
    writeFileSync(join(src, `f${i}.txt`), `${i}\n`);
    git(["add", "-A"], src);
    git(["commit", "-qm", `b${i}`], src);
    git(["branch", "-q", `b${i}`], src);
  }

  let t0 = Date.now();
  const p = git(["push", "-q", url, ...Array.from({ length: N }, (_, i) => `b${i}`)], src);
  check(`push ${N} branches in one push`, p.status === 0, `${Date.now() - t0} ms`);
  t0 = Date.now();
  let [ms, samples] = await untilFresh(t0, 180_000);
  check(`all ${N} branches get facts from their one-branch jobs`, ms !== null, `${ms} ms; ${samples.slice(-4).join(" ")}`);

  // 3 merges, then the list at once, then until fresh.
  for (let k = 0; k < 3; k++) {
    r = await call("POST", `/v1/monorepos/${O}/${M}/repos/${M}/branches/b${k}/merge?force=1`, S);

    if (r.status !== 200) console.log(`      merge b${k}: ${r.status} ${r.json?.error?.code}`);
  }

  t0 = Date.now();
  const lats = [];

  for (let k = 0; k < 3; k++) lats.push((await list(M)).ms);
  const first = await list(M);
  const pending = (first.json?.branches ?? []).filter((b) => b.mergeable === "pending").length;
  check(`list right after 3 merges answers from stored facts (${N} branches)`, Math.max(...lats) < 3000, `${lats.join(", ")} ms; ${pending} pending`);
  [ms, samples] = await untilFresh(t0, 240_000);
  check(`every open branch fresh again after the merges`, ms !== null, `${ms} ms; ${samples.filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 8)) === 0 || i === a.length - 1).join(" ")}`);
  r = await list(M);
  const b = r.json?.branches?.find((x) => x.name === "b5");
  check("a fresh row has ahead 1, behind 6 (3 merge commits and 3 merged commits), mergeable clean", b && b.ahead === 1 && b.behind === 6 && b.mergeable === "clean", JSON.stringify({ ahead: b?.ahead, behind: b?.behind, m: b?.mergeable }));
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  if (made) check(`delete ${M}`, await tw.cleanup());
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
