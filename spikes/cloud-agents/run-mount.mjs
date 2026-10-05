// Stage 0 driver: does `pando` mount a worktree through the ArtifactFS fork
// (Linux FUSE) inside the agent's container, under local wrangler dev?
//
//   node run-mount.mjs            (wrangler dev on 8863, see README.txt)
//
// It proves, in order: pando clone mounts main; pando worktree add mounts a
// branch; edit, commit and push inside the mount; a snapshot with an
// unpushed edit and an unpushed commit, then a new container from it; the
// mount is gone after the restore and `pando worktree mount` brings it back
// with the edits; and a new container from nothing gets the pushed work back
// with pando clone and pando worktree add. No secret is printed.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:8863";
const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../../worker/.dev.vars", import.meta.url), "utf8"))[1];
const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>").replace(/Basic [A-Za-z0-9+/=]{20,}/g, "Basic <credential>");
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

async function sh(session, command) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/s/${session}/ask`, { method: "POST", body: `run: ${command}` });
  const j = await r.json();
  return { text: (j.text ?? JSON.stringify(j)).replace(/^tool finished:\n/, ""), ms: Date.now() - t0 };
}
const post = (session, action) => fetch(`${BASE}/s/${session}/${action}`, { method: "POST" }).then((r) => r.json());

const id = Date.now().toString(36);
const login = `mountspike-${id}`;
const M = `mount-${id}`;
const session = `mount-${id}`;
const WT = "/workspace/r/worktrees/agent-work";
let A;

try {
  let r = await call("POST", "/v1/users", BOOT, { login, name: "Spike", email: "spike@pando.invalid", credential_name: "spike-mbp" });
  A = r.json?.credential?.secret;
  check("a person with a machine credential", r.status === 201 && A?.startsWith("pando_"), r.status);
  r = await call("POST", "/v1/monorepos", A, { name: M, kind: "repo" });
  const cloneUrl = r.json?.repos?.[0]?.clone_url;
  check("a plain repository", r.status === 201 && !!cloneUrl, r.status);
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  mkdirSync(join(src, "pkg"));
  for (let i = 0; i < 50; i++) writeFileSync(join(src, "pkg", `f${i}.txt`), `file ${i}\n`);
  writeFileSync(join(src, "README.md"), "# Mount spike\n\nThis line has a tpyo.\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  let g = git(["push", "-q", cloneUrl, "main"], src, A);
  check("main pushed from the Mac", g.ok, g.out.slice(-300));

  r = await call("POST", "/v1/user/credentials", A, { name: "cloud-1", kind: "sandbox" });
  const S = r.json?.secret;
  await fetch(`${BASE}/s/${session}/setup`, { method: "POST", body: JSON.stringify({ auth: `Basic ${btoa(`x:${S}`)}`, monorepo: `${login}/${M}`, image: "mount" }) });

  // ── Mount ──
  let a = await sh(session, "ls -l /dev/fuse; grep -c fuse /proc/filesystems; id -u");
  check("the container has /dev/fuse and the kernel's fuse", /\/dev\/fuse/.test(a.text) && !/No such file/.test(a.text), `${a.ms} ms (includes the container start)\n${a.text}`);

  a = await sh(session, `cd /workspace && pando clone ${login}/${M} r 2>&1; findmnt -no FSTYPE,OPTIONS r/worktrees/main`);
  check("pando clone mounts main read-only through ArtifactFS", /fuse\.artifact-fs\s+ro/.test(a.text), `${a.ms} ms\n${a.text}`);

  a = await sh(session, `cd /workspace/r && pando worktree add . agent-work 2>&1; echo rc=$?; findmnt -no FSTYPE ${WT}; ls ${WT} | head -3; ls ${WT}/pkg | wc -l`);
  check("pando worktree add mounts a branch worktree and reports it", /rc=0/.test(a.text) && !/did not take it/.test(a.text) && /fuse\.artifact-fs/.test(a.text) && /\n50\n/.test(a.text + "\n"), `${a.ms} ms\n${a.text}`);

  a = await sh(session, `cd ${WT} && sed -i 's/tpyo/typo/' README.md && git commit -qam 'Fix the README typo' && git push -q origin agent-work 2>&1; echo pushed=$?; git log --format='%h %s%n%(trailers:only)' -1`);
  check("edit, commit (with Pando's trailers) and push inside the mount", /pushed=0/.test(a.text) && /Pando-Machine: cloud-1/.test(a.text), `${a.ms} ms\n${a.text}`);
  r = await call("GET", `/v1/monorepos/${login}/${M}/repos/${M}/branches`, A);
  check("Pando lists the branch", JSON.stringify(r.json ?? "").includes("agent-work"));

  // Unpushed work: an edit not committed, and a commit not pushed.
  a = await sh(session, `cd ${WT} && echo 'committed, not pushed' > local-commit.txt && git add local-commit.txt && git commit -qm 'Local only' && echo 'not committed' > pkg/f1.txt && git status --short && git log --oneline -1`);
  check("an unpushed commit and an uncommitted edit", /M pkg\/f1\.txt/.test(a.text), a.text);
  a = await sh(session, "cat /proc/mounts | grep -c artifact-fs; du -sh /root/.pando 2>/dev/null");
  say(`      before the snapshot: ${a.text.replace(/\n/g, " | ")}`);

  // ── Snapshot, then a new container from it ──
  let t0 = Date.now();
  const snap = await post(session, "snapshot");
  check("a snapshot of the running container (it is stopped after)", !snap.error && snap.size > 0, `${Date.now() - t0} ms, ${Math.round((snap.size ?? 0) / 1e6)} MB ${snap.error ?? ""}`);

  a = await sh(session, `findmnt -no FSTYPE ${WT} || echo no-mount; ls -A ${WT} | head -3; echo ---; pgrep -c artifact-fs || echo no-daemon`);
  check("after the restore the mount and the daemon are gone (processes and mounts are not in a snapshot)", /no-mount/.test(a.text) && /no-daemon/.test(a.text), `${a.ms} ms (includes the start from the snapshot)\n${a.text}`);

  a = await sh(session, `cd /workspace/r && pando worktree mount 2>&1; findmnt -no FSTYPE ${WT}; cd ${WT} && git status --short; git log --oneline -2; cat pkg/f1.txt`);
  check("pando worktree mount brings it back with the unpushed commit and the uncommitted edit", /fuse\.artifact-fs/.test(a.text) && /Local only/.test(a.text) && /not committed/.test(a.text), `${a.ms} ms\n${a.text}`);

  a = await sh(session, `cd ${WT} && git commit -qam 'After the restore' && git push -q origin agent-work 2>&1; echo pushed=$?`);
  check("and carries on: commit and push after the restore", /pushed=0/.test(a.text), a.text);

  // ── A new container from nothing ──
  await post(session, "destroy");
  await post(session, "forget");
  t0 = Date.now();
  a = await sh(session, `test -e /workspace/r && echo still-there; cd /workspace && pando clone ${login}/${M} r >/dev/null 2>&1 && cd r && pando worktree add . agent-work 2>&1; cd ${WT} && git log --oneline -4 && cat pkg/f1.txt`);
  check("from nothing: pando clone and pando worktree add bring back every pushed commit", !/still-there/.test(a.text) && /After the restore/.test(a.text) && /Local only/.test(a.text), `${a.ms} ms (includes a fresh container start)\n${a.text}`);
} finally {
  if (A) {
    const r = await call("DELETE", `/v1/monorepos/${login}/${M}?confirm=${login}/${M}`, A);
    check(`cleanup: the repository ${M} (and its Artifacts repo) is deleted`, r.status === 204, r.status);
  }
  await post(session, "destroy").catch(() => {});
}

const passed = results.filter(Boolean).length;
say(`\n${passed} of ${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
