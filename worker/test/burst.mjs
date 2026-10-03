// Parallel pushes through the door: busy refusals and throughput.
//
//   PANDO_URL=https://pando-dev.<subdomain>.workers.dev USE_HOME_CRED=1 ROUNDS=10 P=10 MIX=20 node test/burst.mjs
//
// ROUNDS rounds of P real git pushes at once, each of its own new branch from
// its own clone, into one repo. With MIX, each round also fires MIX API branch
// creates at the same moment (the Worker's own coalesced ref writes). Counts
// Artifacts' "busy" refusals and other failures, and the pushes a second. Git never reaches the
// keychain; credentials are never printed; the monorepo is deleted at the end.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");
const ROUNDS = Number(process.env.ROUNDS ?? 10);
const P = Number(process.env.P ?? 10);
const MIX = Number(process.env.MIX ?? 0);
const call = async (method, path, secret, body) => {
  const res = await fetch(URL_ + path, { method, headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const work = mkdtempSync(join(tmpdir(), "pando-burst-"));
const id = Date.now().toString(36);
let S;
if (process.env.USE_HOME_CRED) S = readFileSync(join(homedir(), ".pando/credentials", new URL(URL_).host), "utf8").trim();
else {
  const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
  S = (await call("POST", "/v1/users", BOOT, { login: `burst-${id}` })).json?.credential?.secret;
}
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" };
const gitArgs = ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", "-c", "http.version=HTTP/1.1"];
const git = (a, cwd) => spawnSync("git", [...gitArgs, ...a], { cwd, env, encoding: "utf8" });
const push = (cwd, url, branch) =>
  new Promise((resolve) => {
    const p = spawn("git", [...gitArgs, "push", "-q", url, branch], { cwd, env });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ ok: code === 0, busy: /receive_pack_busy|busy with other writes/.test(err), err: err.replace(/pando_[a-f0-9]+/g, "<credential>").trim().split("\n").slice(-1)[0] }));
  });

const M = `burst-${id}`;
let O = null; // the owner (namespaces: owner/name), from the create answer
let made = false;
let busy = 0;
let other = 0;
let total = 0;
let mixBad = 0;
const rates = [];
try {
  const r = await call("POST", "/v1/monorepos", S, { name: M, kind: "repo" });
  made = r.status === 201;
  O = r.json?.monorepo?.owner ?? null;
  const url = r.json?.repos?.[0]?.clone_url;
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# burst\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  git(["push", "-q", url, "main"], src);
  for (let k = 0; k < ROUNDS; k++) {
    const dirs = [];
    for (let i = 0; i < P; i++) {
      const d = join(work, `r${k}-a${i}`);
      cpSync(src, d, { recursive: true });
      git(["checkout", "-qb", `r${k}/a${i}`], d);
      git(["commit", "-q", "--allow-empty", "-m", `round ${k} agent ${i}`], d);
      dirs.push(d);
    }
    const t = Date.now();
    const creates = Array.from({ length: MIX }, (_, i) => call("POST", `/v1/monorepos/${O}/${M}/repos/${M}/branches`, S, { name: `r${k}/c${i}` }));
    const res = await Promise.all(dirs.map((d, i) => push(d, url, `r${k}/a${i}`)));
    const secs = (Date.now() - t) / 1000;
    const made = await Promise.all(creates);
    const bad = made.filter((x) => x.status !== 201);
    mixBad += bad.length;
    const b = res.filter((x) => !x.ok && x.busy).length;
    const o = res.filter((x) => !x.ok && !x.busy);
    busy += b;
    other += o.length;
    total += P;
    rates.push(P / secs);
    console.log(`round ${k + 1}: ${P - b - o.length}/${P} ok, ${b} busy, ${o.length} other, ${secs.toFixed(2)} s (${(P / secs).toFixed(1)} pushes/s)${MIX ? `, creates ${MIX - bad.length}/${MIX} ok${bad.length ? " " + bad[0].status + " " + bad[0].json?.error?.code : ""}` : ""}${o.length ? "  " + o[0].err : ""}`);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }
  const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
  console.log(`TOTAL ${total} pushes: ${busy} busy, ${other} other failures; ${avg.toFixed(1)} pushes a second on average (rounds of ${P} at once)${MIX ? `; ${ROUNDS * MIX} creates alongside, ${mixBad} failed` : ""}`);
} finally {
  if (made) await call("DELETE", `/v1/monorepos/${O}/${M}?confirm=${O}/${M}`, S);
  rmSync(work, { recursive: true, force: true });
}
