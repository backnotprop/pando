// A smoke test of the deployed Worker as one real user: the git door on
// Cloudflare's edge, the branch diff, the merge gate and a merge commit.
//
//   PANDO_URL=https://pando-dev.<subdomain>.workers.dev node test/smoke.mjs
//
// It acts as the user signed in on this machine: the credential is read from
// ~/.pando/credentials/<host> (formats.md) or PANDO_CREDENTIAL_FILE, kept in
// memory, and never printed. It makes one monorepo and deletes it at the end.
// Git never reaches the macOS keychain: the system config is skipped and the
// helper list is cleared before Pando's own helper is added.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch, throwaways } from "./errors.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "https://pando-dev.plannotator.workers.dev").replace(/\/$/, "");
const file = process.env.PANDO_CREDENTIAL_FILE ?? join(process.env.PANDO_HOME ?? join(homedir(), ".pando"), "credentials", new URL(URL_).host);
let S;
try {
  S = readFileSync(file, "utf8").trim();
} catch {
  console.log(`No credential at ${file}. Run pando login first.`);
  process.exit(2);
}
const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>").replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<artifacts-token>");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`));
};
const call = async (method, path, body) => {
  const res = await fetch(URL_ + path, {
    method,
    headers: { authorization: `Bearer ${S}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
};
const work = mkdtempSync(join(tmpdir(), "pando-smoke-"));
const git = (args, cwd) => {
  const r = spawnSync(
    "git",
    ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S,
        GIT_AUTHOR_NAME: "Smoke", GIT_AUTHOR_EMAIL: "smoke@pando.invalid", GIT_COMMITTER_NAME: "Smoke", GIT_COMMITTER_EMAIL: "smoke@pando.invalid",
      },
    },
  );
  return { ok: r.status === 0, out: scrub((r.stdout || "") + (r.stderr || "")) };
};

const M = `smoke-${Date.now().toString(36)}`;
let O = null; // the owner (namespaces: owner/name), from the create answer
let made = false;
const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`)).status);
try {
  let r = await call("GET", "/v1/user");
  check("the credential works", r.status === 200, `${r.status} as ${r.json?.login}`);
  // Ask about the name before it exists, from many requests (many isolates).
  for (let i = 0; i < 8; i++) await call("GET", `/v1/monorepos/${O}/${M}`);
  git(["ls-remote", `${URL_}/${O}/${M}.git`], work);
  r = await call("POST", "/v1/monorepos", { name: M, kind: "repo" });
  made = r.status === 201;
  O = r.json?.monorepo?.owner ?? null;
  if (made) tw.add(`${O}/${M}`);
  let stale = 0;
  for (let i = 0; i < 8; i++) if ((await call("GET", `/v1/monorepos/${O}/${M}`)).status !== 200) stale++;
  check("right after creating it, no request sees a cached 404", stale === 0, `${stale} of 8 stale`);
  check("create a plain repo", made, `${r.status}`);
  const url = r.json?.repos?.[0]?.clone_url;
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# smoke\none\ntwo\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  let g = git(["push", "-q", url, "main"], src);
  check("the first push creates main", g.ok, g.out.slice(-200));
  writeFileSync(join(src, "README.md"), "# smoke\nstraight to main\n");
  git(["commit", "-qam", "to main"], src);
  g = git(["push", url, "main"], src);
  check("a second push to main is refused", !g.ok && /main is protected/.test(g.out));
  git(["reset", "-q", "--hard", "HEAD~1"], src);
  git(["checkout", "-qb", "smoke/branch"], src);
  writeFileSync(join(src, "README.md"), "# smoke\none\nTWO\nthree\n");
  writeFileSync(join(src, "big.bin"), Buffer.alloc(3 << 20, 1)); // 3 MiB: git sends a probe, then a chunked body
  git(["add", "-A"], src);
  git(["commit", "-qm", "branch\n\nPando-Agent: smoke-agent\nPando-Machine: smoke-box"], src);
  g = git(["push", "-q", url, "smoke/branch"], src);
  check("push a branch (3 MiB, chunked through the door)", g.ok, g.out.slice(-200));
  const clone = join(work, "clone");
  g = git(["clone", "-q", url, clone], work);
  check("clone through the door", g.ok, g.out.slice(-200));
  const repo = r.json?.repos?.[0]?.name;
  // The list answers at once; its facts land when the queue has computed them.
  let b = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    r = await call("GET", `/v1/monorepos/${O}/${M}/repos/${repo}/branches`);
    b = r.json?.branches?.[0];
    if (b && !b.stale) break;
    await new Promise((res) => setTimeout(res, 300));
  }
  check("branch list, facts fresh", b?.name === "smoke/branch" && b?.ahead === 1 && b?.mergeable === "clean" && b?.stale === false, `${JSON.stringify({ ahead: b?.ahead, mergeable: b?.mergeable })} after ${Date.now() - t0} ms`);
  r = await call("GET", `/v1/monorepos/${O}/${M}/repos/${repo}/branches/smoke%2Fbranch/diff?format=patch`);
  writeFileSync(join(work, "p.patch"), r.text);
  git(["checkout", "-q", r.headers.get("x-pando-merge-base") ?? "main"], clone);
  g = git(["apply", "--check", join(work, "p.patch")], clone);
  check("the patch applies on the merge base", r.status === 200 && g.ok, g.out.slice(-200));
  await call("POST", `/v1/monorepos/${O}/${M}/repos/${repo}/statuses/${b?.head}`, { state: "pending", context: "ci" });
  r = await call("POST", `/v1/monorepos/${O}/${M}/repos/${repo}/branches/smoke%2Fbranch/merge`);
  check("merge waits for checks (412)", r.status === 412);
  await call("POST", `/v1/monorepos/${O}/${M}/repos/${repo}/statuses/${b?.head}`, { state: "success", context: "ci" });
  r = await call("POST", `/v1/monorepos/${O}/${M}/repos/${repo}/branches/smoke%2Fbranch/merge`);
  check("merge with green checks", r.status === 200 && r.json?.status === "merged", `${r.status} ${r.json?.error?.code ?? ""}`);
  git(["fetch", "-q", "origin"], clone);
  const parents = git(["rev-list", "--parents", "-n1", "origin/main"], clone).out.trim().split(" ");
  check("main is a two-parent merge commit", parents.length === 3 && parents[0] === r.json?.sha);
  const me = (await call("GET", "/v1/user")).json;
  r = await call("GET", `/v1/monorepos/${O}/${M}/repos/${repo}/branches?state=merged`);
  const mb = r.json?.branches?.[0];
  check("merge facts on the branch (merged_by, merged_machine, forced)", mb?.merged_by === me?.login && mb?.merged_machine === me?.credential?.name && mb?.forced === false && !!mb?.merged_at, JSON.stringify({ by: mb?.merged_by, forced: mb?.forced }));
  r = await call("GET", `/v1/monorepos/${O}/${M}/repos/${repo}/branches/smoke%2Fbranch/commits`);
  check("the branch's commits with trailers", r.status === 200 && r.json?.commits?.[0]?.trailers?.agent === "smoke-agent" && r.json.commits[0].trailers.machine === "smoke-box", `${r.status}`);
  r = await call("GET", `/v1/monorepos/${O}/${M}/members`);
  check("members carry names", r.status === 200 && r.json?.members?.[0]?.login === me?.login && "name" in (r.json?.members?.[0] ?? {}));
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  if (made) check("delete the test monorepo", await tw.cleanup());
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
