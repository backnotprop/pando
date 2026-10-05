// Releases lane spike (research/plans/releases-2026-10-04): what happens today, against `wrangler dev`, to
//   1. a tag pushed through the git door (lightweight and annotated): accepted? stored in Artifacts? recorded,
//      shown, sent to hooks?
//   2. a merge into main with a Buildkite hook that takes `merged`: which commit and branch does the build get?
//   3. the merge commit on main: any checks?
//
//   PANDO_URL=http://localhost:8867 node test/releases-spike.mjs
//
// Reads PANDO_BOOTSTRAP from worker/.dev.vars. Buildkite is a local stand-in; nothing reaches Buildkite.
// Credentials and tokens are never printed. The repos it makes are deleted at the end.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "./http.mjs";

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8867").replace(/\/$/, "");
const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
const call = (method, path, secret, body) => request(URL_, method, path, { secret, body, redirect: "manual" });
const out = [];
const say = (k, v) => {
  out.push([k, v]);
  console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
};
const waitFor = async (pred, ms = 20_000) => {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await pred();

    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }

  return null;
};

// The Buildkite stand-in: records create-build calls.
const builds = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    builds.push({ commit: body?.commit, branch: body?.branch, message: body?.message, delivery: body?.meta_data?.pando_delivery });
    res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: `b${builds.length}`, number: builds.length, state: "scheduled" }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const id = Date.now().toString(36);
const work = mkdtempSync(join(tmpdir(), "pando-releases-"));
const M = `rel-${id}`;
let O = null;
let S = null;

try {
  S = (await call("POST", "/v1/users", BOOT, { login: `rel-${id}` })).json?.credential?.secret;
  let r = await call("POST", "/v1/monorepos", S, { name: M, kind: "repo" });
  O = r.json?.monorepo?.owner;
  const url = r.json?.repos?.[0]?.clone_url;
  const base = `/v1/monorepos/${O}/${M}/repos/${M}`;
  say("repo made", r.status);

  r = await call("POST", `${base}/hooks`, S, { type: "buildkite", events: ["push", "merged"], buildkite: { organization: "o", pipeline: "p", api_url: `http://127.0.0.1:${port}/buildkite` } });
  say("buildkite hook with push and merged", r.status);

  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, XDG_CONFIG_HOME: join(work, ".config"), GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" };
  const git = (a, cwd) => spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...a], { cwd, env, encoding: "utf8" });
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "f"), "x\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  say("push main", git(["push", "-q", url, "main"], src).status);
  const main1 = git(["rev-parse", "HEAD"], src).stdout.trim();

  // ── 1. Tags ──
  git(["tag", "v0.1.0"], src);
  git(["tag", "-a", "v0.1.1", "-m", "annotated"], src);
  const tagPush = git(["push", url, "v0.1.0", "v0.1.1"], src);
  say("push two tags: exit", tagPush.status);
  say("push two tags: git said", (tagPush.stderr || "").replace(/https?:\/\/\S+/g, "<url>").trim().split("\n").slice(-3).join(" | "));
  const ls = git(["ls-remote", url], src).stdout.trim().split("\n").map((l) => l.split("\t")[1]);
  say("ls-remote refs (from Artifacts through the door)", ls);
  r = await call("GET", `${base}/branches`, S);
  say("branches API names", (r.json?.branches ?? []).map((b) => b.name));
  r = await call("GET", `/v1/monorepos/${O}/${M}/events?since=0&limit=500`, S);
  say("event kinds after the tag push", [...new Set((r.json?.events ?? []).map((e) => e.kind))]);
  say("any event naming refs/tags", (r.json?.events ?? []).some((e) => JSON.stringify(e).includes("refs/tags")));
  const cloned = join(work, "clone");
  git(["clone", "-q", url, cloned], work);
  say("a fresh clone gets the tags", git(["tag", "-l"], cloned).stdout.trim().split("\n"));
  // Moving a tag (force) and deleting one: does the door let it?
  git(["tag", "-f", "v0.1.0", "HEAD"], src);
  say("delete tag v0.1.1: exit", git(["push", url, ":refs/tags/v0.1.1"], src).status);

  // ── 2. A merge, with the hook on `merged` ──
  git(["checkout", "-qb", "feat"], src);
  writeFileSync(join(src, "g"), "y\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "feat"], src);
  git(["push", "-q", url, "feat"], src);
  const head = git(["rev-parse", "HEAD"], src).stdout.trim();
  await waitFor(() => builds.find((b) => b.commit === head));
  r = await call("POST", `${base}/branches/feat/merge`, S, { force: true });
  const mergeSha = r.json?.sha;
  say("merge feat: status, merge commit is new", [r.status, !!mergeSha && mergeSha !== head]);
  await new Promise((res) => setTimeout(res, 4000));
  const short = (s) => (s ?? "").slice(0, 7);
  say("builds the stand-in got (commit, branch)", builds.map((b) => [b.commit === mergeSha ? `merge commit ${short(b.commit)}` : b.commit === head ? `branch head ${short(b.commit)}` : b.commit === main1 ? `main1 ${short(b.commit)}` : short(b.commit), b.branch, b.message]));

  const hooks = (await call("GET", `${base}/hooks`, S)).json?.hooks ?? [];

  for (const h of hooks) {
    const d = (await call("GET", `${base}/hooks/${h.id}/deliveries`, S)).json?.deliveries ?? [];
    say(`deliveries of the ${h.type} hook (event, status, code, error)`, d.map((x) => [x.event, x.status, x.response_code, (x.error ?? "").slice(0, 120)]));
  }

  // ── 3. Checks on main's merge commit ──
  r = await call("GET", `${base}/commits/${mergeSha}/status`, S);
  say("checks on the merge commit", { state: r.json?.state, statuses: (r.json?.statuses ?? []).length });
  r = await call("GET", `${base}/commits/main/status`, S);
  say("checks on main (by name)", { sha_is_merge: r.json?.sha === mergeSha, state: r.json?.state });
} catch (err) {
  console.log(`error: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (O && S) {
    const r = await call("DELETE", `/v1/monorepos/${O}/${M}?confirm=${O}/${M}`, S);
    console.log(`deleted ${M}: ${r.status}`);
  }

  server.close();
  rmSync(work, { recursive: true, force: true });
}
