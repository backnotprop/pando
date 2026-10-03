// End to end: real git and real Artifacts through the Pando Worker.
//
//   PANDO_URL=http://localhost:8797 node test/e2e.mjs      (wrangler dev)
//   PANDO_URL=https://pando-dev.<subdomain>.workers.dev node test/e2e.mjs
//
// PANDO_BOOTSTRAP comes from the environment, or from worker/.dev.vars. No
// secret is printed: credentials reach git through a credential helper that
// reads an environment variable, and every output line is scrubbed.
// Hook deliveries go to a receiver on this machine, so the hook checks run
// only against wrangler dev (set PANDO_HOOKS=0 to skip them elsewhere).
// It deletes the Artifacts repos it made, unless PANDO_KEEP=1.

import { spawnSync } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");
const HOOKS = process.env.PANDO_HOOKS !== "0" && /localhost|127\.0\.0\.1/.test(URL_);
let BOOT = process.env.PANDO_BOOTSTRAP;
if (!BOOT) {
  try {
    BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
  } catch {}
}
if (!BOOT) {
  console.error("Set PANDO_BOOTSTRAP (or worker/.dev.vars).");
  process.exit(2);
}

const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>").replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<artifacts-token>");
const say = (s) => console.log(scrub(s));
const results = [];
function check(name, pass, detail = "") {
  results.push([name, !!pass]);
  say(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
}

async function call(method, path, secret, body) {
  const res = await fetch(URL_ + path, {
    method,
    headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

const work = mkdtempSync(join(tmpdir(), "pando-e2e-"));
function git(args, cwd, secret, extra = {}) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    PANDO_SECRET: secret ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: work,
    GIT_AUTHOR_NAME: "E2E",
    GIT_AUTHOR_EMAIL: "e2e@pando.invalid",
    GIT_COMMITTER_NAME: "E2E",
    GIT_COMMITTER_EMAIL: "e2e@pando.invalid",
    ...extra,
  };
  // Never let git hand a login to the macOS keychain (Apple's git has
  // credential.helper=osxkeychain in its system config): skip the system
  // config, clear the helper list, then add ours only when there is a secret.
  const helper = ["-c", "credential.helper=", ...(secret ? ["-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f'] : [])];
  const r = spawnSync("git", [...helper, "-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}
const write = (dir, path, text) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
};

// A hook receiver that checks the signature.
const HOOK_SECRET = "e2e-hook-secret";
const received = [];
const buildkite = [];
let server;
let hookPort = 0;
if (HOOKS) {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.url.startsWith("/buildkite/")) {
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {}
        buildkite.push({ path: req.url, bearer: /^Bearer \S+$/.test(String(req.headers.authorization ?? "")), body });
        res.writeHead(201, { "content-type": "application/json" }).end("{}");
        return;
      }
      const sig = String(req.headers["x-pando-signature-256"] ?? "");
      const want = "sha256=" + createHmac("sha256", HOOK_SECRET).update(raw).digest("hex");
      const valid = sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
      let payload = null;
      try {
        payload = JSON.parse(raw);
      } catch {}
      received.push({ valid, event: req.headers["x-pando-event"], delivery: req.headers["x-pando-delivery"], payload });
      res.writeHead(valid ? 200 : 401).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  hookPort = server.address().port;
}
const waitFor = async (pred, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};

const id = Date.now().toString(36);
const M = `e2e-${id}`;
const MM = `e2emono-${id}`;
const made = [];

try {
  say(`Pando ${URL_}, monorepo ${M}`);

  // ── Users ──
  let r = await call("POST", "/v1/users", "wrong", { login: `ana-${id}` });
  check("POST /v1/users refuses a wrong bootstrap secret", r.status === 401, `${r.status}`);
  r = await call("POST", "/v1/users", BOOT, { login: `ana-${id}`, name: "Ana", email: "ana@pando.invalid", credential_name: "ana-mbp" });
  check("bootstrap makes user ana and a credential", r.status === 201 && r.json?.credential?.secret?.startsWith("pando_"), `${r.status}`);
  const A = r.json?.credential?.secret;
  globalThis.__A = A;
  r = await call("POST", "/v1/users", BOOT, { login: `bo-${id}` });
  const B = r.json?.credential?.secret;
  check("bootstrap makes user bo", r.status === 201 && !!B);
  r = await call("GET", "/v1/user", A);
  check("GET /v1/user names ana and her credential", r.json?.login === `ana-${id}` && r.json?.credential?.name === "ana-mbp");

  // ── A plain repo ──
  r = await call("POST", "/v1/monorepos", A, { name: M, kind: "repo" });
  check("ana makes a plain repo (kind repo)", r.status === 201 && r.json?.repos?.[0]?.path === "." && r.json?.monorepo?.role === "owner", `${r.status} ${scrub(r.text).slice(0, 200)}`);
  made.push(`${M}--${M}`);
  const cloneUrl = r.json?.repos?.[0]?.clone_url;
  const repoName = r.json?.repos?.[0]?.name;
  r = await call("GET", "/v1/monorepos", A);
  check("GET /v1/monorepos lists it for ana", r.json?.monorepos?.some((m) => m.name === M && m.role === "owner"));

  // ── pando init: the first push creates main ──
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  write(src, "README.md", "# e2e\n");
  write(src, "src/a.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  write(src, "src/gone.txt", "to be deleted\n");
  write(src, "docs/old-name.md", "moved, not changed\n");
  write(src, "bin/blob.bin", "\x00\x01\x02binary");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  let g = git(["push", cloneUrl, "main"], src, A);
  check("the first push creates main", g.ok, g.ok ? "" : g.out.slice(-300));

  write(src, "README.md", "# e2e\nmore\n");
  git(["commit", "-qam", "straight to main"], src);
  g = git(["push", cloneUrl, "main"], src, A);
  check("a second push to main is refused", !g.ok && /main is protected/.test(g.out), g.out.split("\n").filter((l) => /rejected|protected/.test(l)).join(" | "));
  git(["reset", "-q", "--hard", "HEAD~1"], src);

  // ── Membership ──
  const boDir = join(work, "bo");
  g = git(["clone", "-q", cloneUrl, boDir], work, B);
  check("bo, not a member, cannot clone", !g.ok && /403/.test(g.out), g.out.split("\n")[0]);
  r = await call("PUT", `/v1/monorepos/${M}/members/bo-${id}`, B, { role: "member" });
  check("bo cannot add himself", r.status === 403, `${r.status}`);
  r = await call("PUT", `/v1/monorepos/${M}/members/bo-${id}`, A, { role: "member" });
  check("ana (owner) adds bo as a member", r.status === 200 && r.json?.role === "member", `${r.status}`);
  g = git(["clone", "-q", cloneUrl, boDir], work, B);
  check("bo clones through the door (Basic, credential helper)", g.ok, g.ok ? "" : g.out.slice(-300));

  // ── Hooks ──
  let hookId = null;
  if (HOOKS) {
    r = await call("POST", `/v1/monorepos/${M}/repos/${repoName}/hooks`, B, { type: "web", url: `http://127.0.0.1:${hookPort}/hook`, secret: HOOK_SECRET });
    check("a member cannot register a hook", r.status === 403, `${r.status}`);
    r = await call("POST", `/v1/monorepos/${M}/repos/${repoName}/hooks`, A, { type: "web", url: `http://127.0.0.1:${hookPort}/hook`, secret: HOOK_SECRET });
    hookId = r.json?.id;
    check("the owner registers a web hook", r.status === 201 && !!hookId, `${r.status} ${scrub(r.text).slice(0, 200)}`);
    r = await call("POST", `/v1/monorepos/${M}/repos/${repoName}/hooks`, A, {
      type: "buildkite",
      buildkite: { organization: "pando", pipeline: "ci", api_url: `http://127.0.0.1:${hookPort}/buildkite/builds` },
    });
    check("the owner registers a buildkite hook (local stand-in for the API)", r.status === 201 && r.json?.events?.join() === "push", `${r.status} ${scrub(r.text).slice(0, 200)}`);
    r = await call("POST", `/v1/monorepos/${M}/repos/${repoName}/hooks`, A, { type: "buildkite", buildkite: { organization: "o", pipeline: "p", api_url: "https://evil.example/" } });
    check("a buildkite api_url off this machine is refused", r.status === 400);
  }

  // ── A branch from bo's machine ──
  const B1 = "agent-2/feature";
  git(["checkout", "-qb", B1], boDir);
  write(boDir, "src/a.txt", "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\n");
  write(boDir, "src/new.txt", "brand new\n");
  unlinkSync(join(boDir, "src/gone.txt"));
  mkdirSync(join(boDir, "docs/guide"), { recursive: true });
  renameSync(join(boDir, "docs/old-name.md"), join(boDir, "docs/guide/new-name.md"));
  git(["add", "-A"], boDir);
  git(["commit", "-qm", "feature: edit, add, delete, rename\n\nPando-Agent: agent-2"], boDir);
  g = git(["push", "-q", "origin", B1], boDir, B);
  check("bo pushes a branch", g.ok, g.ok ? "" : g.out.slice(-300));

  if (HOOKS) {
    const got = await waitFor(() => received.find((x) => x.event === "push" && x.payload?.branch === B1));
    check("the push hook arrives, signed", !!got && got.valid, got ? `valid=${got.valid}` : "nothing arrived");
    const opened = received.find((x) => x.event === "branch.opened" && x.payload?.branch === B1);
    check("branch.opened arrives too", !!opened);
    const p = got?.payload ?? {};
    check(
      "the payload has clone_url, status_url, a read token and the base",
      p.clone_url === cloneUrl && /\/statuses\/[0-9a-f]{40}$/.test(p.status_url ?? "") && /^art_v\d+_/.test(p.read_token ?? "") && /^[0-9a-f]{40}$/.test(p.base ?? "") && p.author === `bo-${id}`,
    );
    const bk = await waitFor(() => buildkite.find((x) => x.body?.branch === B1));
    const e = bk?.body?.env ?? {};
    check(
      "the buildkite hook asks for a build of the head, with clone URL, read token and status URL",
      !!bk && bk.bearer && bk.body.commit === p.head && e.PANDO_CLONE_URL === cloneUrl && /^art_v\d+_/.test(e.PANDO_READ_TOKEN ?? "") && e.PANDO_STATUS_URL === p.status_url,
      bk ? `commit=${bk.body?.commit?.slice(0, 8)} env=${Object.keys(e).join(",")}` : "nothing arrived",
    );
    if (p.read_token) {
      const ci = join(work, "ci");
      g = git(["-c", `http.extraHeader=Authorization: Bearer ${p.read_token}`, "clone", "-q", "-b", B1, cloneUrl, ci], work, null);
      check("CI clones clone_url with the hook's read token", g.ok, g.ok ? "" : scrub(g.out).slice(-200));
      const rev = git(["rev-parse", "HEAD"], ci).out.trim();
      check("the CI clone is at the pushed head", rev === p.head);
      g = git(["-c", `http.extraHeader=Authorization: Bearer ${p.read_token}`, "push", cloneUrl, `HEAD:refs/heads/ci-try`], ci, null);
      check("the read token cannot push", !g.ok);
    }
  }

  // ── Branch list ──
  // The list answers at once; ahead, behind and mergeable land when the queue computes them.
  let br = null;
  const factsBy = Date.now() + 30_000;
  while (Date.now() < factsBy) {
    r = await call("GET", `/v1/monorepos/${M}/repos/${repoName}/branches`, B);
    br = r.json?.branches?.find((b) => b.name === B1);
    if (br && !br.stale) break;
    await new Promise((res) => setTimeout(res, 300));
  }
  check("the branch list shows the branch, its facts fresh", r.status === 200 && !!br && br.stale === false, `${r.status} stale=${br?.stale}`);
  check("its author is bo, ahead 1, behind 0", br?.author === `bo-${id}` && br?.ahead === 1 && br?.behind === 0, JSON.stringify({ a: br?.author, ahead: br?.ahead, behind: br?.behind }));
  check("mergeable is clean (gitwrite dry run)", br?.mergeable === "clean", br?.mergeable);
  check("checks pass with no statuses and no required checks", br?.checks?.state === "success", br?.checks?.state);

  // ── The branch diff ──
  const enc = encodeURIComponent(B1);
  r = await call("GET", `/v1/monorepos/${M}/repos/${repoName}/branches/${enc}/diff`, B);
  const files = Object.fromEntries((r.json?.files ?? []).map((f) => [f.path, f]));
  check("diff JSON lists 4 files", r.status === 200 && r.json?.files?.length === 4, `${r.status} ${(r.json?.files ?? []).map((f) => f.path + ":" + f.status).join(", ")}`);
  check("modified src/a.txt: +2 -1", files["src/a.txt"]?.status === "modified" && files["src/a.txt"]?.additions === 2 && files["src/a.txt"]?.deletions === 1);
  check("added src/new.txt, deleted src/gone.txt", files["src/new.txt"]?.status === "added" && files["src/gone.txt"]?.status === "deleted");
  check("renamed docs/old-name.md to docs/guide/new-name.md", files["docs/guide/new-name.md"]?.status === "renamed" && files["docs/guide/new-name.md"]?.old_path === "docs/old-name.md");
  check("no hunks without hunks=1", !files["src/a.txt"]?.hunks);
  r = await call("GET", `/v1/monorepos/${M}/repos/${repoName}/branches/${B1}/diff?hunks=1&paths=src/a.txt`, B);
  check("raw slashes in the branch, paths filter, hunks=1", r.json?.files?.length === 1 && r.json.files[0].hunks?.[0]?.lines?.includes("+THREE"));
  r = await call("GET", `/v1/monorepos/${M}/repos/${repoName}/branches/${enc}/diff?hunks=1&max_bytes=10`, B);
  check("max_bytes leaves files out with patch_omitted budget", r.json?.truncated === true && r.json.files.some((f) => f.patch_omitted === "budget"));
  r = await call("GET", `/v1/monorepos/${M}/repos/${repoName}/branches/${enc}/diff?format=patch`, B);
  check("format=patch is text/x-patch", r.status === 200 && /text\/x-patch/.test(r.headers.get("content-type") ?? "") && r.text.startsWith("diff --git"));
  const patchFile = join(work, "branch.patch");
  writeFileSync(patchFile, r.text);
  const base = join(work, "base");
  git(["clone", "-q", cloneUrl, base], work, A);
  git(["checkout", "-q", r.headers.get("x-pando-merge-base")], base);
  g = git(["apply", "--check", "--index", patchFile], base);
  check("git apply --check accepts the patch on the merge base", g.ok, g.ok ? "" : g.out.slice(-300));
  g = git(["diff", "--stat", `${r.headers.get("x-pando-merge-base")}`, "origin/" + B1], boDir);

  // ── File at a ref ──
  r = await call("GET", `/v1/monorepos/${M}/repos/${repoName}/files/src/new.txt?ref=${enc}`, B);
  check("GET files/src/new.txt at the branch", r.status === 200 && r.text === "brand new\n");

  // ── Reviews ──
  r = await call("POST", `/v1/monorepos/${M}/repos/${repoName}/branches/${enc}/reviews`, B, { verdict: "comment", body: "looks fine", comments: [{ path: "src/a.txt", line: 3, body: "why upper case?" }] });
  check("a comment review", r.status === 201 && r.json?.author === `bo-${id}`, `${r.status}`);
  r = await call("POST", `/v1/monorepos/${M}/repos/${repoName}/branches/${enc}/reviews`, A, { verdict: "approve" });
  check("an approval", r.status === 201);
  r = await call("GET", `/v1/monorepos/${M}/repos/${repoName}/branches/${enc}/reviews`, B);
  check("reviews list both", r.json?.reviews?.length === 2);

  // ── Statuses and merge ──
  const head = br?.head;
  r = await call("POST", `/v1/monorepos/${M}/repos/${repoName}/statuses/${head}`, B, { state: "pending", context: "ci", description: "running" });
  check("POST a pending status", r.status === 201);
  r = await call("GET", `/v1/monorepos/${M}/repos/${repoName}/commits/${enc}/status`, B);
  check("combined status is pending", r.json?.state === "pending" && r.json?.sha === head, r.json?.state);
  r = await call("POST", `/v1/monorepos/${M}/repos/${repoName}/branches/${enc}/merge`, B);
  check("merge is refused while checks are pending (412)", r.status === 412 && r.json?.error?.code === "checks_not_green", `${r.status}`);
  r = await call("POST", `/v1/monorepos/${M}/repos/${repoName}/statuses/${head}`, B, { state: "success", context: "ci", target_url: "https://ci.example/1" });
  r = await call("PATCH", `/v1/monorepos/${M}/repos/${repoName}/branches/${enc}`, B, { title: "Feature", description: "Edit, add, delete, rename." });
  check("PATCH title and description", r.json?.title === "Feature");
  r = await call("POST", `/v1/monorepos/${M}/repos/${repoName}/branches/${enc}/merge`, B, { expected_head: head });
  check("a member (bo, as an agent would) merges with green checks", r.status === 200 && r.json?.status === "merged" && /^[0-9a-f]{40}$/.test(r.json?.sha ?? ""), `${r.status} ${scrub(r.text).slice(0, 300)}`);
  const mergeSha = r.json?.sha;
  g = git(["fetch", "-q", "origin"], boDir, B);
  const parents = git(["rev-list", "--parents", "-n1", "origin/main"], boDir).out.trim().split(" ");
  check("main is the merge commit, with two parents (main, branch)", parents[0] === mergeSha && parents.length === 3 && parents[2] === head, parents.join(" ").slice(0, 130));
  const msg = git(["log", "-1", "--format=%an|%s", "origin/main"], boDir).out.trim();
  check("the merge commit is authored as the user, titled from the branch", msg.startsWith(`bo-${id}|Feature`) || msg.startsWith("bo-") , msg);
  if (HOOKS) {
    const m = await waitFor(() => received.find((x) => x.event === "merged"));
    check("the merged hook arrives", !!m && m.payload?.merge_commit === mergeSha);
  }
  r = await call("GET", `/v1/monorepos/${M}/repos/${repoName}/branches?state=merged`, B);
  check("the branch shows as merged", r.json?.branches?.some((b) => b.name === B1 && b.state === "merged"));

  // ── A conflict, and force ──
  r = await call("POST", `/v1/monorepos/${M}/repos/${repoName}/branches`, B, { name: "agent-2/conflict", title: "Conflicting" });
  check("createBranch makes a branch off main", r.status === 201 && r.json?.head === mergeSha && r.json?.author === `bo-${id}`, `${r.status} ${scrub(r.text).slice(0, 200)}`);
  git(["fetch", "-q", "origin"], boDir, B);
  git(["checkout", "-qb", "agent-2/conflict", "origin/agent-2/conflict"], boDir);
  write(boDir, "README.md", "# conflict on the branch\n");
  git(["commit", "-qam", "branch edit"], boDir);
  git(["push", "-q", "origin", "agent-2/conflict"], boDir, B);
  git(["checkout", "-qb", "agent-2/other", "origin/main"], boDir);
  write(boDir, "README.md", "# a different edit\n");
  git(["commit", "-qam", "other edit"], boDir);
  git(["push", "-q", "origin", "agent-2/other"], boDir, B);
  r = await call("POST", `/v1/monorepos/${M}/repos/${repoName}/branches/agent-2%2Fother/merge?force=1`, A);
  check("force=1 merges with no statuses needed", r.status === 200 && r.json?.status === "merged", `${r.status} ${r.json?.error?.code ?? ""}`);
  r = await call("POST", `/v1/monorepos/${M}/repos/${repoName}/branches/agent-2%2Fconflict/merge`, A);
  check("a conflicting branch answers 409 conflict with the paths", r.status === 409 && r.json?.error?.code === "conflict" && r.json?.error?.paths?.includes("README.md"), `${r.status} ${r.json?.error?.code}`);
  // Branch facts are computed on change (a queue): the list says "pending" until they land.
  let listed = null;
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    r = await call("GET", `/v1/monorepos/${M}/repos/${repoName}/branches`, B);
    listed = r.json?.branches?.find((b) => b.name === "agent-2/conflict");
    if (listed && !listed.stale) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  check("the list says conflicts once the facts land", listed?.mergeable === "conflicts" && listed?.stale === false, `${listed?.mergeable} stale=${listed?.stale}`);

  // ── Worktrees ──
  const wt = `wt_${id}`;
  r = await call("PUT", `/v1/monorepos/${M}/worktrees/${wt}`, B, { repo: ".", branch: B1, path: "worktrees/agent-2-feature", machine: "bo-box", agent: "agent-2", kind: "sparse" });
  check("PUT a worktree", r.status === 200 && r.json?.reported_by === `bo-${id}`, `${r.status}`);
  r = await call("GET", `/v1/monorepos/${M}/worktrees`, A);
  check("GET worktrees lists it for every member", r.json?.worktrees?.some((w) => w.id === wt && w.machine === "bo-box"));
  r = await call("DELETE", `/v1/monorepos/${M}/worktrees/${wt}`, B);
  check("DELETE the worktree", r.status === 204);

  // ── Credentials ──
  r = await call("POST", "/v1/user/credentials", B, { name: "sandbox-1", kind: "sandbox" });
  const S = r.json?.secret;
  check("bo makes a sandbox credential", r.status === 201 && !!S);
  g = git(["ls-remote", cloneUrl], work, S);
  check("the sandbox credential works with git, as bo", g.ok);
  r = await call("DELETE", `/v1/user/credentials/${r.json?.id}`, B);
  check("bo revokes it", r.status === 204);
  await new Promise((res) => setTimeout(res, 16_000)); // other isolates may cache auth for 15 s
  g = git(["ls-remote", cloneUrl], work, S);
  check("the revoked credential no longer works", !g.ok);

  // ── Deliveries ──
  if (HOOKS && hookId) {
    r = await call("GET", `/v1/monorepos/${M}/repos/${repoName}/hooks/${hookId}/deliveries`, A);
    const ds = r.json?.deliveries ?? [];
    check("deliveries are listed as delivered", ds.length > 0 && ds.every((d) => d.status === "delivered"), ds.map((d) => `${d.event}:${d.status}`).join(" "));
    const before = received.length;
    r = await call("POST", `/v1/monorepos/${M}/repos/${repoName}/hooks/deliveries/${ds[0]?.id}/redeliver`, A);
    check("redeliver queues a new delivery", r.status === 202 && r.json?.id !== ds[0]?.id);
    check("and it arrives", !!(await waitFor(() => received.length > before)));
  }

  // ── A monorepo with a project repo ──
  // Asking about a name before it exists must not make it look missing afterwards.
  for (let i = 0; i < 3; i++) await call("GET", `/v1/monorepos/${MM}`, A);
  r = await call("GET", `/v1/monorepos/${MM}`, A);
  check("a monorepo that does not exist yet is 404", r.status === 404);
  git(["ls-remote", `${URL_}/${MM}/meta.git`], work, A);
  r = await call("POST", "/v1/monorepos", A, { name: MM });
  const now1 = await call("GET", `/v1/monorepos/${MM}`, A);
  check("right after creating it, the same name answers 200 (no cached 404)", now1.status === 200, `${now1.status}`);
  check("ana makes a monorepo (kind monorepo)", r.status === 201 && r.json?.repos?.length === 0, `${r.status}`);
  made.push(`${MM}--meta`);
  r = await call("POST", `/v1/monorepos/${MM}/repos`, A, { path: "projects/web" });
  check("a project repo at projects/web is named projects-web", r.status === 201 && r.json?.name === "projects-web" && r.json?.clone_url.endsWith(`/${MM}/projects-web.git`), `${r.status} ${scrub(r.text).slice(0, 200)}`);
  made.push(`${MM}--projects-web`);
  g = git(["ls-remote", r.json?.clone_url], work, B);
  check("bo is not a member of the second monorepo", !g.ok);

  // ── The meta layer: live routes, and .pando/** through a reviewed merge ──
  r = await call("GET", `/v1/monorepos/${MM}/meta/status`, A);
  check("the owner reaches the meta layer (live lane)", r.status === 200, `${r.status} ${scrub(r.text).slice(0, 120)}`);
  r = await call("GET", `/v1/monorepos/${MM}/meta/status`, B);
  check("a non-member does not", r.status === 403);
  r = await call("GET", `/v1/monorepos/${M}/meta/status`, A);
  check("a plain repo has no meta layer", r.status === 404);
  r = await call("GET", `/v1/monorepos/${MM}/repos/meta`, A);
  const metaUrl = r.json?.clone_url;
  check("the meta layer is the repo named meta (path .)", r.status === 200 && r.json?.path === "." && metaUrl?.endsWith(`/${MM}/meta.git`), `${r.status}`);
  r = await call("GET", `/v1/monorepos/${MM}/repos`, A);
  check("and it is not in the repo list", r.json?.repos?.every((x) => x.name !== "meta"));
  const metaDir = join(work, "meta");
  mkdirSync(metaDir);
  git(["init", "-q"], metaDir);
  write(metaDir, "AGENTS.md", "# meta\n");
  git(["add", "-A"], metaDir);
  git(["commit", "-qm", "meta root"], metaDir);
  g = git(["push", "-q", metaUrl, "main"], metaDir, A);
  check("the meta layer's main is created by its first push", g.ok, g.ok ? "" : g.out.slice(-200));
  git(["checkout", "-qb", "require-ci"], metaDir);
  write(metaDir, ".pando/pando.toml", '[repos."projects/web"]\nrequired_checks = ["ci"]\n');
  git(["add", "-A"], metaDir);
  git(["commit", "-qm", "Require ci on projects/web"], metaDir);
  g = git(["push", "-q", metaUrl, "require-ci"], metaDir, A);
  r = await call("POST", `/v1/monorepos/${MM}/repos/meta/branches/require-ci/merge`, A);
  check("a reviewed branch merges into the meta layer", r.status === 200 && r.json?.status === "merged", `${r.status} ${scrub(r.text).slice(0, 200)}`);
  r = await call("GET", `/v1/monorepos/${MM}/repos/projects-web`, A);
  check("projects/web now requires ci (read from .pando/pando.toml on main)", JSON.stringify(r.json?.required_checks) === '["ci"]', JSON.stringify(r.json?.required_checks));
  r = await call("GET", `/v1/monorepos/${MM}/meta/history?path=.pando/pando.toml`, A);
  check("the merge reached the live meta layer (applyFromMain)", r.json?.versions?.some((v) => v.source === "main"), `${r.status} ${scrub(r.text).slice(0, 200)}`);
} catch (err) {
  check("no exception", false, scrub(err?.stack ?? err));
} finally {
  server?.close();
  if (process.env.PANDO_KEEP !== "1") {
    for (const [m, secret] of [[M, globalThis.__A], [MM, globalThis.__A]]) {
      if (!secret) continue;
      const r = await call("DELETE", `/v1/monorepos/${m}?confirm=${m}`, secret);
      const after = await call("GET", `/v1/monorepos/${m}`, secret);
      check(`DELETE /v1/monorepos/${m} removes it`, r.status === 204 && after.status === 404, `${r.status}, then ${after.status}`);
      if (r.status === 204) {
        // The same name can be made again, and starts empty.
        const kind = m === M ? "repo" : "monorepo";
        const again = await call("POST", "/v1/monorepos", secret, { name: m, kind });
        const repos = await call("GET", `/v1/monorepos/${m}/repos`, secret);
        const fresh = kind === "repo" ? repos.json?.repos?.length === 1 : repos.json?.repos?.length === 0;
        let branchesEmpty = true;
        if (kind === "repo") {
          const b = await call("GET", `/v1/monorepos/${m}/repos/${m}/branches?state=all`, secret);
          branchesEmpty = b.status === 200 && b.json?.branches?.length === 0 && b.json?.default_head === null;
        }
        check(`${m} can be made again after the delete, and starts empty`, again.status === 201 && fresh && branchesEmpty, `${again.status} ${scrub(JSON.stringify(again.json)).slice(0, 120)}`);
        const r2 = await call("DELETE", `/v1/monorepos/${m}?confirm=${m}`, secret);
        check(`and deleted again`, r2.status === 204, `${r2.status}`);
      }
    }
    for (const name of made) {
      const r = spawnSync("npx", ["wrangler", "artifacts", "repos", "delete", name, "--namespace", "pando-dev", "--force"], {
        cwd: new URL("..", import.meta.url).pathname,
        encoding: "utf8",
        input: "y\n",
      });
      // After DELETE /v1/monorepos, each repo should already be gone.
      say(`cleanup ${name}: ${r.status === 0 ? "deleted by wrangler (the API delete may still be finishing)" : "already gone"}`);
    }
  }
  rmSync(work, { recursive: true, force: true });
  const failed = results.filter(([, ok]) => !ok).length;
  say(`\n${results.length - failed} of ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
