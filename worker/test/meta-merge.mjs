// Merges into the meta layer, and the live files every machine holds
// (concurrency CODE-VS-MODEL M1, M2). A merge's update of the live files
// (applyFromMain) that fails is tried again until it is done, and is applied
// once even when its answer was lost. After a merge, git main and the live
// files agree, even when a live save of a file the branch changes was
// waiting for its commit as the merge landed.
//
//   npx wrangler dev --port 8851 --persist-to <dir> --var META_TEST:1
//   PANDO_URL=http://localhost:8851 node test/meta-merge.mjs
//
// Credentials stay in memory and are never printed. Git never reaches the
// macOS keychain. It deletes its monorepo.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch, throwaways } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");

const WS_ = URL_.replace(/^http/, "ws");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`.replace(/pando_[a-f0-9]{20,}/g, "<credential>"));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let S = null;

const call = (method, path, body, secret = S) => request(URL_, method, path, { secret, body });

const work = mkdtempSync(join(tmpdir(), "pando-mm-"));

const git = (args, cwd) => {
  const r = spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S ?? "", GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" },
  });

  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
};

const blobSha = (bytes) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");

const commit = (dir, files, message) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }

  git(["add", "-A"], dir);
  git(["commit", "-qm", message], dir);
};

async function waitFor(pred, ms) {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await pred();

    if (v) return v;
    await sleep(200);
  }

  return null;
}

const id = Date.now().toString(36);

const O = `mm-${id}`;

const M = `mm-${id}`;

let made = false;

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`)).status);

let ws = null;

try {
  S = (await call("POST", "/v1/users", { login: O }, BOOT)).json?.credential?.secret;
  let r = await call("POST", "/v1/monorepos", { name: M });
  made = r.status === 201;

  if (made) tw.add(`${O}/${M}`);
  const MID = r.json?.monorepo?.id;
  check("a user and a monorepo", !!S && made && !!MID, `${r.status}`);

  if (!MID) throw new Error("no monorepo to test with");
  const sw = await call("POST", "/v1/_meta/test", { monorepo: MID, apply_fail: 0, apply_lose: 0 }, BOOT);

  if (sw.status === 404) throw new Error("start wrangler dev with --var META_TEST:1");
  const base = `/v1/monorepos/${O}/${M}`;

  // The meta layer's main, made by its first push.
  const metaUrl = (await call("GET", `${base}/repos/meta`)).json?.clone_url;
  const meta = join(work, "meta");
  mkdirSync(meta);
  git(["init", "-q"], meta);
  commit(meta, { "AGENTS.md": "# meta\n", "notes/plan.md": "v0\n", "other.md": "other v0\n" }, "meta root");
  check("the meta layer's main is made by its first push", git(["push", "-q", metaUrl, "main"], meta).ok);

  // A machine on the meta layer's socket: every change it receives, in order.
  const frames = [];
  ws = new WebSocket(`${WS_}${base}/meta/socket`, { headers: { authorization: `Bearer ${S}` } });
  ws.onmessage = (m) => frames.push(JSON.parse(m.data));
  ws.onerror = () => {};

  await waitFor(() => ws.readyState === 1, 10_000);
  ws.send(JSON.stringify({ type: "hello", since: 0, machine: "mm-mbp", agent: null, client: "meta-merge-test/1" }));
  check("a machine is live on the meta layer", !!(await waitFor(() => frames.find((f) => f.type === "caught_up"), 10_000)));
  const fromMain = (path) => frames.filter((f) => f.type === "change" && f.path === path && f.source === "main");

  const mainVersions = async (path) => {
    const h = await call("GET", `${base}/meta/history?path=${encodeURIComponent(path)}&limit=50`);

    return (h.json?.versions ?? []).filter((v) => v.source === "main");
  };

  // A branch made from main as it is now, changing these files; pushed, not merged.
  const pushBranch = (branch, files) => {
    git(["fetch", "-q", metaUrl, "main"], meta);
    git(["checkout", "-qB", branch, "FETCH_HEAD"], meta);
    commit(meta, files, `Change ${Object.keys(files).join(", ")}`);

    return git(["push", "-qf", metaUrl, branch], meta).ok;
  };

  const merge = (branch) => call("POST", `${base}/repos/meta/branches/${branch}/merge`);

  const mergeBranch = (branch, files) => (pushBranch(branch, files), merge(branch));

  // ── M2: a failed applyFromMain is tried again, and applied once ──
  const TOML = ".pando/pando.toml";
  r = await call("POST", "/v1/_meta/test", { monorepo: MID, apply_fail: 1 }, BOOT);
  check("the switch is on: the next applyFromMain fails (META_TEST)", r.json?.applyFail === 1, JSON.stringify(r.json));
  r = await mergeBranch("toml", { [TOML]: 'local_only = ["scratch/"]\n' });
  const merged = Date.now();
  check("a branch changing .pando/pando.toml merges", r.status === 200 && r.json?.status === "merged", `${r.status} ${r.json?.error?.code ?? ""}`);
  const arrived = await waitFor(() => fromMain(TOML).length > 0, 10_000);
  check("the machine receives the change though the first applyFromMain failed", !!arrived, arrived ? `${Date.now() - merged} ms after the merge answered` : "not within 10 s");
  await sleep(3_000);
  let versions = await mainVersions(TOML);
  check("it arrives once: one change on the socket, one version from main", fromMain(TOML).length === 1 && versions.length === 1, `${fromMain(TOML).length} on the socket, ${versions.length} in history`);

  r = await call("POST", "/v1/_meta/test", { monorepo: MID, apply_lose: 1 }, BOOT);
  check("the switch is on: the next applyFromMain applies, then its answer is lost", r.json?.applyLose === 1, JSON.stringify(r.json));
  r = await mergeBranch("toml-2", { [TOML]: 'local_only = ["scratch/", "tmp/"]\n' });
  check("a second change to .pando/pando.toml merges", r.status === 200 && r.json?.status === "merged", `${r.status} ${r.json?.error?.code ?? ""}`);
  await waitFor(() => fromMain(TOML).length > 1, 10_000);
  await sleep(4_000); // a retry would come after 1 s
  versions = await mainVersions(TOML);
  check("applied once although its answer was lost and it was sent again", fromMain(TOML).length === 2 && versions.length === 2, `${fromMain(TOML).length} on the socket, ${versions.length} in history`);
  r = await call("GET", `${base}/meta/file?path=${encodeURIComponent(TOML)}`);
  check("the live file is the second merge's", r.text === 'local_only = ["scratch/", "tmp/"]\n', JSON.stringify(r.text));

  // ── M1: after a merge into the meta layer, git main and the live files agree ──
  const gitMain = (path) => {
    git(["fetch", "-q", metaUrl, "main"], meta);
    const g = git(["show", `FETCH_HEAD:${path}`], meta);

    return g.ok ? g.out : null;
  };

  const liveFile = async (path) => {
    const f = await call("GET", `${base}/meta/file?path=${encodeURIComponent(path)}`);

    return f.status === 200 ? f.text : null;
  };

  const save = async (path, text, baseVersion) => {
    const bytes = Buffer.from(text);
    const sid = `s-${path}-${Date.now()}`;
    ws.send(JSON.stringify({ type: "save", id: sid, path, base_version: baseVersion, sha: blobSha(bytes), bytes: bytes.toString("base64") }));

    return waitFor(() => frames.find((f) => f.id === sid && (f.type === "accepted" || f.type === "stale" || f.type === "refused")), 10_000);
  };

  // Everything live is in git (nothing waits for its commit), then the files compared.
  const settled = async () => waitFor(async () => {
    const st = (await call("GET", `${base}/meta/status`)).json;

    return st?.uncommitted === 0 && !st?.commit_error ? st : null;
  }, 30_000);

  const agree = async (paths) => {
    const pairs = [];

    for (const p of paths) pairs.push([p, gitMain(p), await liveFile(p)]);

    return { ok: pairs.every(([, g, l]) => g === l), detail: pairs.map(([p, g, l]) => `${p}: git ${JSON.stringify(g)}, live ${JSON.stringify(l)}`).join("; ") };
  };

  // A branch made from main before a live save changes the same file; it merges seconds after the save.
  check("a branch changing notes/plan.md is pushed", pushBranch("fix", { "notes/plan.md": "from the branch\n" }));
  const saved = await save("notes/plan.md", "ana, live\n", 0);
  check("a live save of notes/plan.md is accepted (its commit is due in 10 s)", saved?.type === "accepted", saved?.type);
  r = await merge("fix");
  check("the branch merges, or is refused as a conflict", (r.status === 200 && r.json?.status === "merged") || (r.status === 409 && r.json?.error?.code === "conflict"), `${r.status} ${r.json?.status ?? r.json?.error?.code}`);
  check("then every live save is committed, with no commit error", !!(await settled()));
  let same = await agree(["notes/plan.md"]);
  check("git main and the live files hold the same notes/plan.md (git never goes back to the older live save)", same.ok, same.detail);

  // The branch changes another file: the merge lands, and the live save is committed on top of it.
  // notes/plan.md is saved again on top of the merge's version: its reservation has ended, so it commits too.
  const planNow = (await call("GET", `${base}/meta/history?path=notes/plan.md&limit=1`)).json?.versions?.[0]?.version ?? 0;
  const again = await save("notes/plan.md", "ana, after the merge\n", planNow);
  check("a live save of notes/plan.md on top of the merge's version is accepted", again?.type === "accepted", again?.type);
  check("a branch changing other.md is pushed", pushBranch("other", { "other.md": "other, from the branch\n" }));
  const saved2 = await save("notes/plan2.md", "ana, live 2\n", 0);
  r = await merge("other");
  check("a branch changing another file merges", saved2?.type === "accepted" && r.status === 200 && r.json?.status === "merged", `${saved2?.type}, ${r.status} ${r.json?.status ?? r.json?.error?.code}`);
  check("then every live save is committed, with no commit error", !!(await settled()));
  same = await agree(["notes/plan.md", "notes/plan2.md", "other.md", TOML]);
  check("git main and the live files agree on every path both hold, the save after the merge included", same.ok && gitMain("notes/plan.md") === "ana, after the merge\n", same.detail);
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  ws?.close();

  if (made) check(`delete ${O}/${M}`, await tw.cleanup());
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
