// The file pages (FILES.md): a project's folder at any ref, the last commit
// per entry, a path's history, raw files, the cache's repo isolation, and
// the default entrypoint never cached. Real git is the oracle: every answer is
// checked against `git log --first-parent` on a local clone.
//
//   npx wrangler dev --port 8797 [--var FILES_BUDGET:1]
//   PANDO_URL=http://localhost:8797 node test/files.mjs
//   PANDO_URL=https://pando-dev... USE_HOME_CRED=1 node test/files.mjs   (as the signed-in user)
//
// With FILES_BUDGET=1 the walks stop early, so the queue path (last commits)
// and short history pages run too. Credentials stay in memory; git never
// reaches the keychain; it deletes what it made.
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
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + String(detail).slice(0, 300) + ")" : ""}`.replace(/pando_[a-f0-9]{20,}/g, "<credential>"));
};

let S = null;

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(URL_ + path, { method, headers: { authorization: `Bearer ${S}`, ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {}

  return { status: res.status, json, text, headers: res.headers };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), "pando-files-"));

const git = (args, cwd) => {
  const r = spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S ?? "", GIT_AUTHOR_NAME: "Ana", GIT_AUTHOR_EMAIL: "ana@pando.invalid", GIT_COMMITTER_NAME: "Ana", GIT_COMMITTER_EMAIL: "ana@pando.invalid" },
  });

  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.replace(/pando_[a-f0-9]+/g, "<credential>"), stdout: r.stdout };
};

const write = (dir, path, content) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

const id = Date.now().toString(36);

let O = `files-${id}`;

const A = `fa-${id}`;

const B = `fb-${id}`;

const made = [];

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`)).status);

try {
  if (HOME_CRED) {
    S = readFileSync(join(homedir(), ".pando/credentials", new URL(URL_).host), "utf8").trim();
    O = (await call("GET", "/v1/user")).json?.login;
  } else S = (await call("POST", "/v1/users", { login: O }, { authorization: `Bearer ${BOOT}` })).json?.credential?.secret;

  for (const m of [A, B]) {
    const r = await call("POST", "/v1/monorepos", { name: m, kind: "repo" });

    if (r.status === 201) {
      made.push(m);
      tw.add(`${O}/${m}`);
    }
  }

  check("two plain repos", made.length === 2);
  const urlOf = (m) => `${URL_}/${O}/${m}.git`;
  const base = (m) => `/v1/monorepos/${O}/${m}/repos/${m}`;

  // ── History: c1 (everything), c2 (src/a.txt), c3 (src/b.txt), then a branch merged ──
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  write(src, "README.md", "# files\n");
  write(src, "src/a.txt", "one\n");
  write(src, "src/lib/deep/x.txt", "deep\n");
  write(src, "docs/guide.md", "guide\n");
  write(src, "index.html", "<script>alert(1)</script>\n");
  write(src, "logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n');
  write(src, "pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
  write(src, "bin.dat", Buffer.from([1, 2, 0, 3]));
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  const c1 = git(["rev-parse", "HEAD"], src).stdout.trim();
  write(src, "src/a.txt", "one\ntwo\n");
  git(["commit", "-qam", "a gets two"], src);
  write(src, "src/b.txt", "b\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "add b"], src);
  check("push main (3 commits)", git(["push", "-q", urlOf(A), "main"], src).ok);
  git(["checkout", "-qb", "feat/x"], src);
  write(src, "docs/guide.md", "guide, better\n");
  git(["commit", "-qam", "Better guide"], src);
  check("push feat/x", git(["push", "-q", urlOf(A), "feat/x"], src).ok);
  let r = await call("POST", `${base(A)}/branches/feat%2Fx/merge?force=1`);
  check("merge feat/x into main (a merge commit)", r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
  git(["fetch", "-q", urlOf(A), "main"], src);
  git(["checkout", "-q", "-B", "main", "FETCH_HEAD"], src);
  const head = git(["rev-parse", "HEAD"], src).stdout.trim();
  const oracleLast = (path) => git(["log", "-1", "--first-parent", "--format=%H", "--", path], src).stdout.trim();
  const oracleLog = (path) => git(["log", "--first-parent", "--format=%H", "--", path], src).stdout.trim().split("\n").filter(Boolean);

  const lsTree = (ref, path = "") => git(["ls-tree", ref, ...(path ? [`${path}/`] : [])], src).stdout.trim().split("\n").filter(Boolean).map((l) => {
    const [meta, name] = l.split("\t");

    return { type: meta.split(" ")[1], name: name.split("/").pop() };
  });

  // ── Folders ──
  r = await call("GET", `${base(A)}/tree`);
  const want = lsTree("HEAD");
  check("the root at main: every entry, folders first", r.status === 200 && r.json?.commit === head && r.json.entries.length === want.length && r.json.entries[0].type === "dir" && want.every((w) => r.json.entries.some((e) => e.name === w.name && (e.type === "dir") === (w.type === "tree"))), `${r.status} ${r.json?.entries?.map((e) => e.name).join(",")}`);
  r = await call("GET", `${base(A)}/tree?path=src/lib/deep`);
  check("a folder three deep", r.status === 200 && r.json?.entries?.length === 1 && r.json.entries[0].name === "x.txt", `${r.status}`);
  r = await call("GET", `${base(A)}/tree?ref=feat%2Fx&path=docs`);
  check("at a branch with / in its name", r.status === 200 && r.json?.ref === "feat/x" && r.json.entries[0].name === "guide.md", `${r.status} ${r.json?.error?.message ?? ""}`);
  r = await call("GET", `${base(A)}/tree?ref=${c1}&path=src`);
  check("at a sha (c1: no b.txt yet)", r.status === 200 && r.json?.commit === c1 && !r.json.entries.some((e) => e.name === "b.txt"), `${r.status}`);
  const paged = [];
  let cursor = null;

  for (let i = 0; i < 20; i++) {
    r = await call("GET", `${base(A)}/tree?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    paged.push(...(r.json?.entries ?? []).map((e) => e.name));
    cursor = r.json?.next;

    if (!cursor) break;
  }

  check("pages of 2 walk the same entries", paged.length === want.length && new Set(paged).size === want.length, paged.join(","));
  r = await call("GET", `${base(A)}/tree?path=README.md`);
  check("a file is not a folder (404 not_a_folder)", r.status === 404 && r.json?.error?.code === "not_a_folder", `${r.status}`);
  r = await call("GET", `${base(A)}/tree?ref=nope-${id}`);
  check("an unknown ref is a 404", r.status === 404, `${r.status}`);

  // ── The last commit per entry (git log -1 --first-parent is the oracle) ──
  const lastAll = async (path) => {
    for (let i = 0; i < 60; i++) {
      const x = await call("GET", `${base(A)}/tree/last-commits${path ? `?path=${path}` : ""}`);

      if (x.json?.complete) return { ...x, tries: i + 1 };
      await sleep(x.json?.retry_after_ms ?? 1000);
    }

    return null;
  };

  let lc = await lastAll("");
  const rootOk = lc && want.every((w) => lc.json.entries[w.name]?.sha === oracleLast(w.name));
  check("last commits at the root match git log -1 --first-parent", rootOk, lc ? `${lc.tries} tries; ${want.map((w) => `${w.name}:${lc.json.entries[w.name]?.sha?.slice(0, 7)}/${oracleLast(w.name).slice(0, 7)}`).join(" ")}` : "never complete");
  check("a change merged from a branch shows the merge and its branch", lc?.json?.entries?.docs?.merged_branch?.branch === "feat/x", JSON.stringify(lc?.json?.entries?.docs?.merged_branch));
  lc = await lastAll("src");
  check("last commits in src match", lc && ["a.txt", "b.txt", "lib"].every((n) => lc.json.entries[n]?.sha === oracleLast(`src/${n}`)), lc ? JSON.stringify(Object.fromEntries(Object.entries(lc.json.entries).map(([k, v]) => [k, v?.sha?.slice(0, 7)]))) : "never complete");
  r = await call("GET", `${base(A)}/tree/last-commits?path=src&names=a.txt`);
  check("names= narrows the answer (served stored)", r.json?.complete && Object.keys(r.json.entries).join() === "a.txt", JSON.stringify(Object.keys(r.json?.entries ?? {})));

  // ── A path's history (git log --first-parent -- path) ──
  const histAll = async (path, limit = 30) => {
    const shas = [];
    let next = null;

    for (let i = 0; i < 100; i++) {
      const x = await call("GET", `${base(A)}/history?path=${path}&limit=${limit}${next ? `&cursor=${next}` : ""}`);

      if (x.status !== 200) return { error: `${x.status} ${x.text.slice(0, 120)}` };
      shas.push(...x.json.commits.map((c) => c.sha));
      next = x.json.next;

      if (!next) break;
    }

    return { shas };
  };

  for (const [path, limit] of [["src/a.txt", 30], ["src", 30], ["src", 1], ["docs/guide.md", 30]]) {
    const h = await histAll(path, limit);
    const o = oracleLog(path);
    check(`history of ${path} (pages of ${limit}) matches`, h.shas && h.shas.join() === o.join(), h.error ?? `${h.shas?.map((s) => s.slice(0, 7)).join(",")} vs ${o.map((s) => s.slice(0, 7)).join(",")}`);
  }

  // ── Raw ──
  const rawUrl = (m, path, ref) => `/${O}/${m}/raw/${path}${ref ? `?ref=${ref}` : ""}`;
  r = await call("GET", rawUrl(A, "README.md"));
  const etag = r.headers.get("etag");
  check(
    "raw by branch: the bytes, text/plain, sandboxed, nosniff, revalidated by ETag",
    r.status === 200 && r.text === "# files\n" && /^text\/plain/.test(r.headers.get("content-type")) && /sandbox/.test(r.headers.get("content-security-policy") ?? "") && r.headers.get("x-content-type-options") === "nosniff" && r.headers.get("cache-control") === "private, no-cache" && /^(W\/)?"[0-9a-f]{40}"$/.test(etag ?? ""),
    `${r.status} ${r.headers.get("content-type")} ${r.headers.get("cache-control")}`,
  );
  r = await call("GET", rawUrl(A, "README.md"), null, { "if-none-match": etag });
  check("the same ETag again is a 304", r.status === 304, `${r.status}`);
  r = await call("HEAD", rawUrl(A, "README.md"));
  check("HEAD has the headers and no body", r.status === 200 && r.text === "" && r.headers.get("etag") === etag);
  r = await call("GET", rawUrl(A, "src/a.txt", c1));
  check("raw at a sha: the old bytes, cached a year", r.text === "one\n" && r.headers.get("cache-control") === "private, max-age=31536000, immutable", r.headers.get("cache-control"));

  for (const [path, type] of [["index.html", "text/plain"], ["logo.svg", "text/plain"], ["pic.png", "image/png"], ["bin.dat", "application/octet-stream"]]) {
    r = await call("GET", rawUrl(A, path));
    check(`raw ${path} is ${type}`, r.status === 200 && (r.headers.get("content-type") ?? "").startsWith(type), r.headers.get("content-type"));
  }

  r = await call("GET", rawUrl(A, "src"));
  check("raw on a folder is a 404", r.status === 404 && r.json?.error?.code === "not_a_file", `${r.status}`);
  r = await call("GET", `/${O}/${A}/projects/${A}/raw/README.md`);
  check("a plain repo has no /projects/ raw path", r.status === 404, `${r.status}`);
  r = await fetch(URL_ + rawUrl(A, "README.md"));
  check("raw needs a credential", r.status === 401, `${r.status}`);

  // ── Raw on a monorepo's project: the web's address names the folder (projects/web is the repo projects-web) ──
  const P = `fp-${id}`;
  r = await call("POST", "/v1/monorepos", { name: P });

  if (r.status === 201) {
    made.push(P);
    tw.add(`${O}/${P}`);
  }

  r = await call("POST", `/v1/monorepos/${O}/${P}/repos`, { path: "projects/web" });
  const webUrl = r.json?.clone_url;
  const psrc = join(work, "p");
  mkdirSync(psrc);
  git(["init", "-q"], psrc);
  write(psrc, "src/a.ts", "export const a = 1;\n");
  git(["add", "-A"], psrc);
  git(["commit", "-qm", "web"], psrc);
  const pushedWeb = git(["push", "-q", webUrl, "main"], psrc).ok;
  r = await call("GET", `/${O}/${P}/projects/web/raw/src/a.ts`);
  const webEtag = r.headers.get("etag");
  check("raw on a monorepo project by its folder (/projects/web/raw/...): 200 with the bytes", pushedWeb && r.status === 200 && r.text === "export const a = 1;\n", `${r.status} ${r.json?.error?.message ?? ""}`);
  r = await call("GET", `/${O}/${P}/projects/web/raw/src/a.ts`, null, { "if-none-match": webEtag });
  check("the project file's ETag again is a 304", r.status === 304, `${r.status}`);

  // ── The cache keeps repos apart: B's commit asked through A ──
  const bsrc = join(work, "b");
  mkdirSync(bsrc);
  git(["init", "-q"], bsrc);
  write(bsrc, "secret.txt", `only in ${B}\n`);
  git(["add", "-A"], bsrc);
  git(["commit", "-qm", "b's own"], bsrc);
  const shaB = git(["rev-parse", "HEAD"], bsrc).stdout.trim();
  git(["push", "-q", urlOf(B), "main"], bsrc);
  r = await call("GET", `${base(B)}/tree?ref=${shaB}`);
  const warmB = await call("GET", rawUrl(B, "secret.txt", shaB));
  check("B's commit and file, read through B (warming the cache)", r.status === 200 && warmB.text === `only in ${B}\n`);
  r = await call("GET", `${base(A)}/tree?ref=${shaB}`);
  check("B's commit through A is a 404", r.status === 404, `${r.status}`);
  r = await call("GET", rawUrl(A, "secret.txt", shaB));
  check("B's file through A is a 404", r.status === 404, `${r.status}`);

  // ── The default entrypoint is never cached, even when it says it may be ──
  const p1 = await (await fetch(`${URL_}/v1/_probe/uncached`)).json();
  const p2res = await fetch(`${URL_}/v1/_probe/uncached`);
  const p2 = await p2res.json();
  check("the Worker's own answers are never cached (two probes, two ids)", p1.id && p2.id && p1.id !== p2.id && p2res.headers.get("cf-cache-status") !== "HIT", p2res.headers.get("cf-cache-status") ?? "no cf-cache-status");
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  if (made.length) check(`delete ${made.map((m) => `${O}/${m}`).join(", ")}`, await tw.cleanup());
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
