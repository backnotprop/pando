// Two checks on the deployed Worker, as the user signed in on this machine:
//
//   PANDO_URL=https://pando-dev.<subdomain>.workers.dev node test/edge.mjs
//
// 1. Revocation: a throwaway credential ("revocation-test") is made, used
//    once with the API and once with git, revoked, and then polled until it
//    stops working (the Worker caches answers for up to 15 s per isolate).
//    The machine's own credential is only used to make and revoke it.
// 2. Large pushes through the git door: branches of 4 to 12 MiB of
//    incompressible bytes, each timed, then the branch diff of the largest.
//    Git runs with http.version=HTTP/1.1 and http.postBuffer at 100 MiB, the
//    settings the CLI uses for Pando remotes. Measured on this Mac with Apple
//    git (LibreSSL): a 12 MiB push over HTTP/2 fails about one time in four
//    with "SSL_read: bad record mac", straight to Artifacts too (6 of 8), and
//    a bigger postBuffer alone does not help (12 of 16); HTTP/1.1 with the
//    pack in one sized request passed 24 of 24; HTTP/1.1 chunked hangs.
//
// Credentials stay in memory and are never printed. Git never reaches the
// macOS keychain. Everything made is deleted at the end.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = (process.env.PANDO_URL ?? "https://pando-dev.plannotator.workers.dev").replace(/\/$/, "");
const file = process.env.PANDO_CREDENTIAL_FILE ?? join(process.env.PANDO_HOME ?? join(homedir(), ".pando"), "credentials", new URL(URL_).host);
const S = readFileSync(file, "utf8").trim();
const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>").replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<artifacts-token>");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, secret, body) => {
  const res = await fetch(URL_ + path, {
    method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
};
const work = mkdtempSync(join(tmpdir(), "pando-edge-"));
const git = (args, cwd, secret) => {
  const t = Date.now();
  const r = spawnSync(
    "git",
    ["-c", "http.version=HTTP/1.1", "-c", "http.postBuffer=104857600", "-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 1 << 26,
      env: {
        ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: secret,
        GIT_AUTHOR_NAME: "Edge", GIT_AUTHOR_EMAIL: "edge@pando.invalid", GIT_COMMITTER_NAME: "Edge", GIT_COMMITTER_EMAIL: "edge@pando.invalid",
      },
    },
  );
  return { ok: r.status === 0, ms: Date.now() - t, out: scrub((r.stdout || "") + (r.stderr || "")) };
};

const M = `edge-${Date.now().toString(36)}`;
let O = null; // the owner (namespaces: owner/name), from the create answer
let made = false;
let throwaway = null;
try {
  let r = await call("POST", "/v1/monorepos", S, { name: M, kind: "repo" });
  made = r.status === 201;
  O = r.json?.monorepo?.owner ?? null;
  check("create a test plain repo", made, `${r.status}`);
  const url = r.json?.repos?.[0]?.clone_url;
  const repo = r.json?.repos?.[0]?.name;
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src, S);
  writeFileSync(join(src, "README.md"), "# edge\n");
  git(["add", "-A"], src, S);
  git(["commit", "-qm", "first"], src, S);
  check("push main", git(["push", "-q", url, "main"], src, S).ok);

  // ── 1. Revocation ──
  r = await call("POST", "/v1/user/credentials", S, { name: "revocation-test", kind: "sandbox" });
  throwaway = r.json;
  const T = throwaway?.secret;
  check("make the throwaway credential revocation-test", r.status === 201 && !!T, `${r.status} ${throwaway?.id}`);
  r = await call("GET", "/v1/user", T);
  check("it works with the API", r.status === 200 && r.json?.credential?.name === "revocation-test", `${r.status} as ${r.json?.login}`);
  check("it works with git", git(["ls-remote", url], work, T).ok);
  r = await call("DELETE", `/v1/user/credentials/${throwaway.id}`, S);
  const revokedAt = Date.now();
  check("revoke it (with the machine credential)", r.status === 204, `${r.status}`);
  let firstRefusal = null;
  while (Date.now() - revokedAt < 30_000) {
    const a = await call("GET", "/v1/user", T);
    if (a.status === 401 && firstRefusal === null) firstRefusal = Date.now() - revokedAt;
    if (a.status !== 401) firstRefusal = null; // another isolate may still answer from its cache
    if (firstRefusal !== null && Date.now() - revokedAt > 16_000) break;
    await sleep(1000);
  }
  check("the API refuses it within 15 s, and keeps refusing", firstRefusal !== null && firstRefusal <= 15_000, firstRefusal === null ? "still accepted after 30 s" : `refused from ${firstRefusal} ms after the revoke`);
  let gitRefused = 0;
  for (let i = 0; i < 3; i++) if (!git(["ls-remote", url], work, T).ok) gitRefused++;
  check("git refuses it too (3 of 3 tries)", gitRefused === 3, `${gitRefused} of 3`);
  r = await call("GET", "/v1/user/credentials", S);
  check("it is gone from the credential list; the machine credential still works", r.status === 200 && !r.json?.credentials?.some((c) => c.id === throwaway.id));
  throwaway = null;

  // ── 2. Large pushes through the door ──
  const sizes = [4, 6, 8, 12, 4, 6, 8, 12];
  let failures = 0;
  for (let i = 0; i < sizes.length; i++) {
    git(["checkout", "-q", "main"], src, S);
    git(["checkout", "-qb", `big/${i}`], src, S);
    writeFileSync(join(src, `blob${i}.bin`), randomBytes(sizes[i] << 20));
    git(["add", "-A"], src, S);
    git(["commit", "-qm", `${sizes[i]} MiB`], src, S);
    const p = git(["push", "-q", url, `big/${i}`], src, S);
    if (!p.ok) failures++;
    check(`push a ${sizes[i]} MiB branch through the door`, p.ok, `${p.ms} ms${p.ok ? "" : ": " + p.out.split("\n").filter(Boolean).slice(-3).join(" | ")}`);
  }
  check("no push failed (no \"Network connection lost\")", failures === 0, `${failures} failed`);
  r = await call("GET", `/v1/monorepos/${O}/${M}/repos/${repo}/branches/big%2F3/diff`, S);
  check("the diff of the 12 MiB branch reads only the start of the blob", r.status === 200 && r.json?.files?.[0]?.patch_omitted === "binary", `${r.status} ${JSON.stringify(r.json?.files?.map((f) => [f.path, f.patch_omitted]))}`);
  const clone = join(work, "clone");
  const c = git(["clone", "-q", "--branch", "big/3", url, clone], work, S);
  check("clone the 12 MiB branch back through the door", c.ok, `${c.ms} ms`);
} catch (err) {
  check("no exception", false, String(err?.stack ?? err));
} finally {
  if (throwaway?.id) await call("DELETE", `/v1/user/credentials/${throwaway.id}`, S);
  if (made) {
    const r = await call("DELETE", `/v1/monorepos/${O}/${M}?confirm=${O}/${M}`, S);
    check("delete the test monorepo", r.status === 204, `${r.status}`);
  }
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
