// The git door's busy retry: Artifacts runs about 2 receive-packs at once per
// repo and answers others "busy". A push up to 1 MiB is held in memory and
// sent again once after a short wait; a larger one gets a plain "push again".
//
//   npx wrangler dev --port 8797 --var DOOR_TEST:1
//   PANDO_URL=http://localhost:8797 node test/busy.mjs
//
// With DOOR_TEST=1, a push carrying X-Pando-Test-Busy: 1 has its first attempt
// taken as busy without being sent, so both paths run on demand. Real git,
// real Artifacts. Credentials stay in memory; git never reaches the keychain.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch } from "./errors.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");
const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`.replace(/pando_[a-f0-9]{20,}/g, "<credential>"));
};
const call = async (method, path, secret, body) => {
  const res = await fetch(URL_ + path, { method, headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const work = mkdtempSync(join(tmpdir(), "pando-busy-"));
let S = null;
const git = (args, cwd, extra = []) => {
  const r = spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...extra, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S ?? "", GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" },
  });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.replace(/pando_[a-f0-9]+/g, "<credential>") };
};
const BUSY = ["-c", "http.extraHeader=X-Pando-Test-Busy: 1"];

const id = Date.now().toString(36);
const M = `busy-${id}`;
let O = null;
try {
  S = (await call("POST", "/v1/users", BOOT, { login: `busy-${id}` })).json?.credential?.secret;
  const r = await call("POST", "/v1/monorepos", S, { name: M, kind: "repo" });
  O = r.json?.monorepo?.owner ?? null;
  const url = r.json?.repos?.[0]?.clone_url;
  check("a plain repo", r.status === 201 && !!url);
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# busy\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  check("push main", git(["push", "-q", url, "main"], src).ok);

  // Small: the first attempt is taken as busy; the door waits and sends it again.
  git(["checkout", "-qb", "small"], src);
  writeFileSync(join(src, "a.txt"), "small change\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "small"], src);
  const t = Date.now();
  let g = git(["push", "-q", url, "small"], src, BUSY);
  const ms = Date.now() - t;
  check("a small push refused once as busy goes through on the door's retry", g.ok, g.ok ? `${ms} ms` : g.out.slice(-300));
  let b = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/branches/small`, S);
  check("and its branch is recorded", b.status === 200 && b.json?.name === "small", `${b.status}`);

  // Large (over 1 MiB): not held in memory, so not retried: a plain message.
  git(["checkout", "-qb", "large", "main"], src);
  writeFileSync(join(src, "big.bin"), randomBytes(1_600_000));
  git(["add", "-A"], src);
  git(["commit", "-qm", "large"], src);
  g = git(["push", "-q", url, "large"], src, BUSY);
  check("a push over 1 MiB refused as busy fails with a plain message", !g.ok && /busy with other pushes right now; push again/.test(g.out) && !/artifacts_git_receive_pack_busy/.test(g.out), g.out.split("\n").filter(Boolean).slice(0, 2).join(" | "));
  b = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/branches/large`, S);
  check("and nothing was pushed", b.status === 404, `${b.status}`);
  g = git(["push", "-q", url, "large"], src);
  check("pushing it again goes through", g.ok, g.out.slice(-200));
  b = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/branches/large`, S);
  check("and its branch is recorded", b.status === 200, `${b.status}`);

  // A failed Artifacts call (X-Pando-Test-Fail: the first attempt throws, unsent): never a bare 500.
  const FAIL = ["-c", "http.extraHeader=X-Pando-Test-Fail: 1"];
  git(["checkout", "-qb", "small-fail", "main"], src);
  writeFileSync(join(src, "f.txt"), "after a failed call\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "small-fail"], src);
  g = git(["push", "-q", url, "small-fail"], src, FAIL);
  b = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/branches/small-fail`, S);
  check("a small push whose first Artifacts call fails goes through on the retry", g.ok && b.status === 200, g.ok ? `${b.status}` : g.out.slice(-200));
  git(["checkout", "-qb", "large-fail", "main"], src);
  writeFileSync(join(src, "big2.bin"), randomBytes(1_600_000));
  git(["add", "-A"], src);
  git(["commit", "-qm", "large-fail"], src);
  g = git(["push", "-q", url, "large-fail"], src, FAIL);
  check("a push over 1 MiB whose Artifacts call fails gets a plain message, not a 500", !g.ok && /couldn't take this push right now; push again/.test(g.out) && !/HTTP 500|RPC failed/.test(g.out), g.out.split("\n").filter(Boolean).slice(0, 2).join(" | "));
  b = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/branches/large-fail`, S);
  check("and nothing was pushed", b.status === 404, `${b.status}`);

  // Without DOOR_TEST the headers do nothing (checked when the server runs without it).
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
