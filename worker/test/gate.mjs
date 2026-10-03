// The write gate, end to end (Artifacts takes about two receive-packs at once
// per repo; the gate queues the rest).
//
//   PANDO_URL=http://localhost:8797 node test/gate.mjs                 (wrangler dev, .dev.vars)
//   PANDO_URL=https://pando-dev... USE_HOME_CRED=1 node test/gate.mjs  (as the signed-in user)
//
// 5, 20 and 50 parallel branch creates, 10 parallel real git pushes through
// the door, parallel deletes and merges racing a push: all must succeed. It
// also measures the ceiling: small pushes per second per repo.
// Credentials stay in memory; git never reaches the keychain; it cleans up.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch, throwaways } from "./errors.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`.replace(/pando_[a-f0-9]{20,}/g, "<credential>"));
};

const call = async (method, path, secret, body) => {
  const res = await fetch(URL_ + path, { method, headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {}

  return { status: res.status, json };
};

const work = mkdtempSync(join(tmpdir(), "pando-gate-"));

const id = Date.now().toString(36);

let S;

if (process.env.USE_HOME_CRED) S = readFileSync(join(homedir(), ".pando/credentials", new URL(URL_).host), "utf8").trim();
else {
  const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
  S = (await call("POST", "/v1/users", BOOT, { login: `gate-${id}` })).json?.credential?.secret;
}

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" };

const gitArgs = ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", "-c", "http.version=HTTP/1.1"];

const git = (a, cwd) => spawnSync("git", [...gitArgs, ...a], { cwd, env, encoding: "utf8" });

const gitAsync = (a, cwd) =>
  new Promise((resolve) => {
    const p = spawn("git", [...gitArgs, ...a], { cwd, env });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ ok: code === 0, err: err.replace(/pando_[a-f0-9]+/g, "<credential>").trim().split("\n").filter((l) => !/^error: failed to push/.test(l)).join(" | ") }));
  });

const tally = (rs, ok) => {
  const by = {};

  for (const r of rs) {
    const k = ok(r) ? "ok" : r.label;
    by[k] = (by[k] ?? 0) + 1;
  }

  return JSON.stringify(by);
};

const M = `gate-${id}`;

let O = null; // the owner (namespaces: owner/name), from the create answer

let made = false;

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, S)).status);

try {
  let r = await call("POST", "/v1/monorepos", S, { name: M, kind: "repo" });
  made = r.status === 201;
  O = r.json?.monorepo?.owner ?? null;

  if (made) tw.add(`${O}/${M}`);
  const url = r.json?.repos?.[0]?.clone_url;
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# gate\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  check("push main", git(["push", "-q", url, "main"], src).status === 0);
  const branches = (q = "") => call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/branches?state=all${q}`, S);

  // ── parallel branch creates ──
  for (const n of [5, 20, 50]) {
    const t = Date.now();

    const rs = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        call("POST", `/v1/monorepos/${O}/${M}/repos/${M}/branches`, S, { name: `c${n}/b${i}` }).then((x) => ({ ...x, label: `${x.status} ${x.json?.error?.code}` })),
      ),
    );

    const ms = Date.now() - t;
    const okN = rs.filter((x) => x.status === 201).length;
    const exist = ((await branches()).json?.branches ?? []).filter((b) => b.name.startsWith(`c${n}/`)).length;
    check(`${n} parallel branch creates all succeed`, okN === n && exist === n, `${ms} ms, ${tally(rs, (x) => x.status === 201)}, ${exist} exist`);
  }

  // ── parallel real git pushes through the door ──
  const N = 10;

  for (let i = 0; i < N; i++) {
    cpSync(src, join(work, `a${i}`), { recursive: true });
    git(["checkout", "-qb", `agent-${i}/work`], join(work, `a${i}`));
    writeFileSync(join(work, `a${i}`, `w${i}.txt`), `agent ${i}\n`);
    git(["add", "-A"], join(work, `a${i}`));
    git(["commit", "-qm", `agent ${i}`], join(work, `a${i}`));
  }

  let t = Date.now();
  const pushes = await Promise.all(Array.from({ length: N }, (_, i) => gitAsync(["push", "-q", url, `agent-${i}/work`], join(work, `a${i}`)).then((x) => ({ ...x, label: x.err }))));
  check(`${N} parallel git pushes through the door all succeed`, pushes.every((x) => x.ok), `${Date.now() - t} ms, ${tally(pushes, (x) => x.ok)}`);
  r = await branches();
  check("every pushed branch is recorded with its author", Array.from({ length: N }, (_, i) => `agent-${i}/work`).every((b) => r.json?.branches?.some((x) => x.name === b && x.author)));

  // ── merges racing pushes, then parallel deletes ──
  for (let i = 0; i < 3; i++) git(["commit", "-q", "--allow-empty", "-m", `more ${i}`], join(work, `a${i + 3}`));
  t = Date.now();

  const mixed = await Promise.all([
    ...[0, 1, 2].map((i) => call("POST", `/v1/monorepos/${O}/${M}/repos/${M}/branches/agent-${i}%2Fwork/merge?force=1`, S).then((x) => ({ ok: x.status === 200, label: `merge ${x.status} ${x.json?.error?.code}` }))),
    ...[3, 4, 5].map((i) => gitAsync(["push", "-q", url, `agent-${i}/work`], join(work, `a${i}`)).then((x) => ({ ok: x.ok, label: `push ${x.err}` }))),
  ]);

  check("3 merges and 3 pushes at once all succeed", mixed.every((x) => x.ok), `${Date.now() - t} ms, ${tally(mixed, (x) => x.ok)}`);
  t = Date.now();
  const dels = await Promise.all(Array.from({ length: 20 }, (_, i) => call("DELETE", `/v1/monorepos/${O}/${M}/repos/${M}/branches/c20%2Fb${i}`, S).then((x) => ({ ...x, label: `${x.status} ${x.json?.error?.code}` }))));
  const left = ((await branches()).json?.branches ?? []).filter((b) => b.name.startsWith("c20/")).length;
  check("20 parallel branch deletes all succeed", dels.every((x) => x.status === 204) && left === 0, `${Date.now() - t} ms, ${tally(dels, (x) => x.status === 204)}, ${left} left`);

  // ── the ceiling: small pushes per second per repo ──
  const P = 12;
  const pdir = join(work, "p");
  cpSync(src, pdir, { recursive: true });

  for (let i = 0; i < P; i++) {
    git(["checkout", "-q", "main"], pdir);
    git(["checkout", "-qb", `ceil/${i}`], pdir);
    git(["commit", "-q", "--allow-empty", "-m", `ceiling ${i}`], pdir);
  }

  t = Date.now();

  const many = await Promise.all(Array.from({ length: P }, (_, i) => {
    const d = join(work, `p${i}`);
    cpSync(pdir, d, { recursive: true });

    return gitAsync(["push", "-q", url, `ceil/${i}`], d).then((x) => ({ ...x, label: x.err }));
  }));

  const secs = (Date.now() - t) / 1000;
  check(`${P} small pushes at once all succeed`, many.every((x) => x.ok), `${secs.toFixed(1)} s: ${(P / secs).toFixed(1)} pushes a second through one repo`);
  t = Date.now();

  for (let i = 0; i < 5; i++) {
    const d = join(work, `p${i}`);
    git(["commit", "-q", "--allow-empty", "-m", `again ${i}`], d);
    git(["push", "-q", url, `ceil/${i}`], d);
  }

  console.log(`      one small push after another: ${((Date.now() - t) / 5).toFixed(0)} ms each`);
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  if (made) check(`delete ${M}`, await tw.cleanup());
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
