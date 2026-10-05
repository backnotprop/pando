// Spike 2 and 3 driver. Throwaway.
//
// Spike 2: a session's container clones a Pando repository through the local
// door and pushes a branch. The sandbox credential is added by the session's
// gateway outside the container; the container never sees it.
// Spike 3: the container is destroyed; the session is recalled; the model's
// context still holds the earlier work and the workspace comes back by
// cloning the session's own branch.
//
//   node run-spike2.mjs            (wrangler dev on 8863, see README.md)
//
// No secret is printed: output is scrubbed, and git gets the Mac-side
// credential through a helper reading an environment variable, with the
// system config skipped and the helper list cleared first (AGENTS.md).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:8863";
const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../../worker/.dev.vars", import.meta.url), "utf8"))[1];
const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>").replace(/Basic [A-Za-z0-9+/=]{20,}/g, "Basic <credential>").replace(/art_v\d+_[A-Za-z0-9]+/g, "<artifacts-token>");
const say = (s) => console.log(scrub(s));
const results = [];
const check = (name, pass, detail = "") => {
  results.push(!!pass);
  say(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "\n      " + String(detail).replace(/\n/g, "\n      ") : ""}`);
};

async function call(method, path, secret, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

const work = mkdtempSync(join(tmpdir(), "pando-cloud-agents-"));
function git(args, cwd, secret) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: work, PANDO_SECRET: secret ?? "",
    GIT_AUTHOR_NAME: "Spike", GIT_AUTHOR_EMAIL: "spike@pando.invalid", GIT_COMMITTER_NAME: "Spike", GIT_COMMITTER_EMAIL: "spike@pando.invalid" };
  const helper = ["-c", "credential.helper=", ...(secret ? ["-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f'] : [])];
  const r = spawnSync("git", [...helper, "-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

async function ask(session, prompt) {
  const r = await fetch(`${BASE}/s/${session}/ask`, { method: "POST", body: prompt });
  return r.json();
}

const id = Date.now().toString(36);
const login = `cloudspike-${id}`;
const M = `agents-${id}`;
const session = `fix-${id}`;
let A;

try {
  // ── A person, a repository with main, and a credential for the session ──
  let r = await call("POST", "/v1/users", BOOT, { login, name: "Spike", email: "spike@pando.invalid", credential_name: "spike-mbp" });
  A = r.json?.credential?.secret;
  check("bootstrap makes a person with a machine credential", r.status === 201 && A?.startsWith("pando_"), r.status);
  r = await call("POST", "/v1/monorepos", A, { name: M, kind: "repo" });
  const cloneUrl = r.json?.repos?.[0]?.clone_url;
  check("a plain repository", r.status === 201 && !!cloneUrl, `${r.status} ${scrub(cloneUrl)}`);
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# Agents spike\n\nThis line has a tpyo.\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  let g = git(["push", "-q", cloneUrl, "main"], src, A);
  check("main pushed from the Mac", g.ok, g.out.slice(-300));

  // What launch would do: a sandbox credential for this person, one per session.
  r = await call("POST", "/v1/user/credentials", A, { name: "cloud-1", kind: "sandbox" });
  const S = r.json?.secret;
  const credId = r.json?.id;
  check("a sandbox credential named cloud-1", r.status === 201 && S?.startsWith("pando_"), r.status);
  r = await fetch(`${BASE}/s/${session}/setup`, { method: "POST", body: JSON.stringify({ auth: `Basic ${btoa(`x:${S}`)}`, monorepo: `${login}/${M}` }) });
  check("the session holds the credential (in its Durable Object, not the sandbox)", r.status === 200);

  // ── Spike 2: clone, commit, push from the container ──
  const remote = `http://pando.internal/${login}/${M}.git`;
  const branch = "fix/12-readme-typo";
  let t0 = Date.now();
  let a = await ask(session, `run: git clone -q ${remote} /workspace/r && cd /workspace/r && git checkout -q -b ${branch} && sed -i 's/tpyo/typo/' README.md && git commit -qam 'Fix the README typo

Fixes #12' && git push -q origin ${branch} 2>&1; echo pushed=$?; git log --oneline -2`);
  check("the agent clones through pando.internal, commits, and pushes a branch", /pushed=0/.test(a.text ?? ""), `${Date.now() - t0} ms (first call includes the container start)\n${a.text}`);

  r = await call("GET", `/v1/monorepos/${login}/${M}/repos/${encodeURIComponent((cloneUrl.match(/\/([^/]+)\.git$/) || [])[1] ?? "")}/branches`, A);
  const listed = JSON.stringify(r.json ?? r.text);
  check("Pando lists the branch", listed.includes(branch), scrub(listed).slice(0, 300));

  r = await call("GET", `/v1/monorepos/${login}/${M}/machines`, A);
  check("the Machines tab sees cloud-1", JSON.stringify(r.json ?? "").includes("cloud-1"), scrub(JSON.stringify(r.json)).slice(0, 400));

  a = await ask(session, "run: cd /workspace/r && (env; git config --list; cat .git/config) | grep -ci 'pando_\\|authorization\\|basic ' ; echo end");
  check("no credential anywhere in the sandbox's environment or git config", /^exit 0\n0\n|exit 1\n0\n/.test((a.text ?? "").replace("tool finished:\n", "")), a.text);

  a = await ask(session, "run: git ls-remote http://pando.internal/someone-else/other.git 2>&1 | tail -1; curl -s -o /dev/null -w '%{http_code}' http://pando.internal/v1/user; echo; curl -s -m 5 -o /dev/null -w '%{http_code}' https://example.com || echo no-internet");
  check("the gateway refuses other repositories and the API; the sandbox has no internet", /403/.test(a.text ?? "") && /no-internet|000/.test(a.text ?? ""), a.text);

  a = await ask(session, "run: cd /workspace/r && git push -q origin HEAD:main 2>&1 | tail -2; echo rc=$?");
  check("a push to main is refused by Pando's door", /protected/.test(a.text ?? ""), a.text);

  // ── Spike 3: the container is gone, the session is recalled ──
  r = await fetch(`${BASE}/s/${session}/destroy`, { method: "POST" });
  check("the container is destroyed", (await r.json()).running === false);
  a = await ask(session, "recall");
  check("recall: the model's context still holds the earlier prompts", /earlier prompts/.test(a.text ?? "") && (a.text ?? "").includes("git clone"), a.text);
  t0 = Date.now();
  a = await ask(session, `run: test -d /workspace/r && echo still-there || (git clone -q -b ${branch} ${remote} /workspace/r && cd /workspace/r && git log --oneline -2 && grep -c typo README.md)`);
  check("recall: the workspace is restored by cloning the session's branch", !/still-there/.test(a.text ?? "") && /Fix the README typo/.test(a.text ?? ""), `${Date.now() - t0} ms (includes a fresh container start)\n${a.text}`);

  // Revoke: the session's credential stops working at once.
  r = await call("DELETE", `/v1/user/credentials/${credId}`, A);
  await new Promise((res) => setTimeout(res, 16000)); // auth answers are cached per isolate for 15 s
  a = await ask(session, "run: git ls-remote http://pando.internal/" + `${login}/${M}.git 2>&1 | tail -1`);
  check("after revoking cloud-1, the sandbox can no longer reach the repository", r.status === 204 && /401|403|Authentication|denied|could not read Username/i.test(a.text ?? ""), `${r.status}\n${a.text}`);
} finally {
  if (A) {
    const r = await call("DELETE", `/v1/monorepos/${login}/${M}?confirm=${login}/${M}`, A);
    check(`cleanup: the repository ${M} (and its Artifacts repo) is deleted`, r.status === 204, r.status);
  }
  await fetch(`${BASE}/s/${session}/destroy`, { method: "POST" }).catch(() => {});
}

const passed = results.filter(Boolean).length;
say(`\n${passed} of ${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
