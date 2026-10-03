// The event stream and the data the web screens need, end to end: real git
// through the door, real Artifacts, the meta layer object, against
// `wrangler dev` (bootstrap secret from worker/.dev.vars) or a deployed Worker.
//
//   PANDO_URL=http://localhost:8797 node test/events.mjs
//
// Credentials stay in memory and are never printed. Git never reaches the
// macOS keychain. It deletes the monorepos it made.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");
const WS_ = URL_.replace(/^http/, "ws");
let BOOT = process.env.PANDO_BOOTSTRAP;
if (!BOOT) BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>").replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<artifacts-token>");
const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`));
};
// The event stream can be switched off on the server (worker/src/monorepo/stream.ts).
let STREAM = true;
let skipped = 0;
const checkS = (name, ok, detail = "") => {
  if (STREAM) return check(name, ok, detail);
  skipped++;
  console.log(`SKIP  ${name}  (the event stream is on hold)`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, secret, body, headers = {}) => {
  const res = await fetch(URL_ + path, {
    method,
    headers: { authorization: `Bearer ${secret}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
};
const work = mkdtempSync(join(tmpdir(), "pando-events-"));
const git = (args, cwd, secret) => {
  const r = spawnSync("git", ["-c", "credential.helper=", ...(secret ? ["-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f'] : []), "-c", "init.defaultBranch=main", ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: secret ?? "", GIT_AUTHOR_NAME: "Ana", GIT_AUTHOR_EMAIL: "ana@pando.invalid", GIT_COMMITTER_NAME: "Ana", GIT_COMMITTER_EMAIL: "ana@pando.invalid" },
  });
  return { ok: r.status === 0, out: scrub((r.stdout || "") + (r.stderr || "")) };
};

/** An event socket that collects frames. */
function openEvents(m, secret, since = null) {
  const frames = [];
  const url = `${WS_}/v1/monorepos/${m}/events${since === null ? "" : `?since=${since}`}`;
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${secret}` } });
  const state = { ws, frames, open: false, closed: null, error: null };
  ws.onopen = () => (state.open = true);
  ws.onmessage = (e) => {
    if (e.data === "pong") return frames.push({ type: "pong" });
    try {
      frames.push(JSON.parse(e.data));
    } catch {
      frames.push({ type: "unparsed", data: String(e.data) });
    }
  };
  ws.onclose = (e) => (state.closed = e.code);
  ws.onerror = (e) => (state.error = e.message ?? "error");
  return state;
}
async function waitFor(pred, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = pred();
    if (v) return v;
    await sleep(100);
  }
  return null;
}
const eventsOf = (s) => s.frames.filter((f) => f.type === "event");
const find = (s, pred) => (STREAM ? waitFor(() => eventsOf(s).find(pred)) : Promise.resolve(null));
const blobSha = (bytes) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");

const id = Date.now().toString(36);
const M = `ev-${id}`;
const made = [];
let A = null;
const sockets = [];
try {
  // ── Setup: two users, a monorepo with one project repo ──
  A = (await call("POST", "/v1/users", BOOT, { login: `ana-${id}`, name: "Ana Lima", email: `ana-${id}@pando.invalid`, credential_name: "ana-mbp" })).json?.credential?.secret;
  const B = (await call("POST", "/v1/users", BOOT, { login: `bo-${id}` })).json?.credential?.secret;
  check("two users", !!A && !!B);
  let r = await call("POST", "/v1/monorepos", A, { name: "settings" });
  check("a reserved name (settings) is refused", r.status === 400, `${r.status}`);
  r = await call("POST", "/v1/monorepos", A, { name: M });
  made.push(M);
  check("make a monorepo", r.status === 201);
  r = await call("POST", `/v1/monorepos/${M}/repos`, A, { path: "projects/web" });
  const url = r.json?.clone_url;
  const repo = r.json?.name;
  r = await call("GET", `/v1/monorepos/${M}/events?limit=1`, A);
  STREAM = r.status !== 501;
  console.log(STREAM ? "The event stream is on." : "The event stream is on hold (501): its checks are skipped.");
  r = await call("GET", `/v1/monorepos/${M}/members`, A);
  check("members carry display names", r.json?.members?.[0]?.name === "Ana Lima", JSON.stringify(r.json?.members?.[0]));

  // ── The socket: members only ──
  const outsider = openEvents(M, B);
  if (STREAM) await waitFor(() => outsider.closed !== null || outsider.error, 10_000);
  checkS("a non-member cannot open the event socket", !outsider.open || outsider.closed !== null, `open=${outsider.open} closed=${outsider.closed} error=${outsider.error}`);
  const ev = openEvents(M, A);
  sockets.push(ev);
  const caught = STREAM ? await waitFor(() => ev.frames.find((f) => f.type === "caught_up")) : null;
  checkS("the owner opens the event socket and is caught up", !!caught, JSON.stringify(caught));
  if (STREAM) ev.ws.readyState === 1 && ev.ws.send("ping");
  checkS("ping gets pong", STREAM && !!(await waitFor(() => ev.frames.find((f) => f.type === "pong"), 5000)));

  // ── push main, then a branch ──
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# web\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  check("push main through the door", git(["push", "-q", url, "main"], src, A).ok);
  const mainHead = git(["rev-parse", "HEAD"], src).out.trim();
  let e = await find(ev, (x) => x.collection === "default_heads" && x.row?.default_head === mainHead);
  checkS("event: push of main (default_heads upsert)", e?.kind === "push" && e?.key === repo && e?.machine === "ana-mbp" && e?.actor === `ana-${id}`, scrub(JSON.stringify(e)).slice(0, 200));

  git(["checkout", "-qb", "feat/a"], src);
  writeFileSync(join(src, "a.txt"), "a\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "Add a\n\nPando-Agent: agent-1\nPando-Worktree: projects/web/worktrees/feat-a\nPando-Machine: ana-mbp"], src);
  writeFileSync(join(src, "a.txt"), "a\nb\n");
  git(["commit", "-qam", "More a\n\nPando-Agent: agent-1\nPando-Worktree: projects/web/worktrees/feat-a\nPando-Machine: ana-mbp"], src);
  check("push a branch", git(["push", "-q", url, "feat/a"], src, A).ok);
  const headA = git(["rev-parse", "HEAD"], src).out.trim();
  e = await find(ev, (x) => x.kind === "branch.opened" && x.row?.name === "feat/a");
  checkS("event: branch.opened with the Branch row", e?.collection === "branches" && e?.op === "upsert" && e?.key === `${repo}/feat/a` && e?.row?.head === headA && e?.row?.ahead === 2 && e?.row?.author === `ana-${id}`, scrub(JSON.stringify(e?.row)).slice(0, 200));
  r = await call("GET", `/v1/monorepos/${M}/repos/${repo}/branches/feat%2Fa`, A);
  const same = ["name", "head", "base", "author", "ahead", "behind", "mergeable", "state"].every((k) => JSON.stringify(r.json?.[k]) === JSON.stringify(e?.row?.[k]));
  checkS("the event's row has the same shape and values as GET getBranch", same && Object.keys(r.json ?? {}).every((k) => k in (e?.row ?? {})));

  // ── commits with trailers ──
  r = await call("GET", `/v1/monorepos/${M}/repos/${repo}/branches/feat%2Fa/commits`, A);
  const cm = r.json?.commits ?? [];
  check("GET .../commits lists the branch's 2 commits, newest first", r.status === 200 && cm.length === 2 && cm[0].sha === headA && cm[0].title === "More a" && r.json?.total === 2, `${r.status} ${cm.map((x) => x.title).join(" | ")}`);
  check("trailers parsed (agent, worktree, machine)", cm[0]?.trailers?.agent === "agent-1" && cm[0]?.trailers?.worktree === "projects/web/worktrees/feat-a" && cm[0]?.trailers?.machine === "ana-mbp" && cm[0]?.author?.name === "Ana");

  // ── branch.updated: title; status; review ──
  r = await call("PATCH", `/v1/monorepos/${M}/repos/${repo}/branches/feat%2Fa`, A, { title: "Feature A" });
  e = await find(ev, (x) => x.kind === "branch.updated" && x.row?.title === "Feature A");
  checkS("event: branch.updated after PATCH", !!e);
  await call("POST", `/v1/monorepos/${M}/repos/${repo}/statuses/${headA}`, A, { state: "success", context: "ci" }, { "x-pando-agent": "ci-bot" });
  e = await find(ev, (x) => x.kind === "status" && x.row?.sha === headA);
  checkS("event: status (Status row, agent from X-Pando-Agent)", e?.collection === "statuses" && e?.key === `${repo}/${headA}/ci` && e?.row?.state === "success" && e?.agent === "ci-bot", scrub(JSON.stringify(e)).slice(0, 160));
  e = await find(ev, (x) => x.kind === "branch.updated" && x.row?.name === "feat/a" && x.row?.checks?.state === "success" && x.row?.checks?.statuses?.length === 1);
  checkS("event: branch.updated with the new checks", !!e);
  await call("POST", `/v1/monorepos/${M}/repos/${repo}/branches/feat%2Fa/reviews`, A, { verdict: "comment", body: "ok" });
  e = await find(ev, (x) => x.kind === "review");
  checkS("event: review (Review row)", e?.collection === "reviews" && e?.row?.verdict === "comment" && e?.row?.branch === "feat/a");

  // ── worktrees ──
  await call("PUT", `/v1/monorepos/${M}/worktrees/wt_${id}`, A, { repo: "projects/web", branch: "feat/a", path: "projects/web/worktrees/feat-a", machine: "ana-mbp", agent: "agent-1", kind: "sparse" });
  e = await find(ev, (x) => x.kind === "worktree.reported");
  checkS("event: worktree.reported (Worktree row)", e?.collection === "worktrees" && e?.key === `wt_${id}` && e?.row?.agent === "agent-1");
  await call("DELETE", `/v1/monorepos/${M}/worktrees/wt_${id}`, A);
  e = await find(ev, (x) => x.kind === "worktree.removed");
  checkS("event: worktree.removed (op delete)", e?.op === "delete" && e?.key === `wt_${id}`);

  // ── a second branch, then merge the first ──
  git(["checkout", "-q", "main"], src);
  git(["checkout", "-qb", "feat/b"], src);
  writeFileSync(join(src, "b.txt"), "b\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "Add b"], src);
  git(["push", "-q", url, "feat/b"], src, A);
  await find(ev, (x) => x.kind === "branch.opened" && x.row?.name === "feat/b");
  r = await call("POST", `/v1/monorepos/${M}/repos/${repo}/branches/feat%2Fa/merge`, A, {}, { "x-pando-agent": "agent-1" });
  const mergeSha = r.json?.sha;
  check("merge feat/a (as agent-1)", r.status === 200 && r.json?.status === "merged", `${r.status} ${r.json?.error?.code ?? ""}`);
  e = await find(ev, (x) => x.kind === "merged");
  checkS("event: merged, with merge facts on the Branch row", e?.row?.state === "merged" && e?.row?.merge_commit === mergeSha && e?.row?.merged_by === `ana-${id}` && e?.row?.merged_machine === "ana-mbp" && e?.row?.merged_agent === "agent-1" && e?.row?.forced === false && !!e?.row?.merged_at, scrub(JSON.stringify(e?.row)).slice(0, 260));
  e = await find(ev, (x) => x.kind === "default_head.updated");
  checkS("event: default_head.updated to the merge commit", e?.row?.default_head === mergeSha);
  e = await find(ev, (x) => x.kind === "branch.updated" && x.row?.name === "feat/b" && x.row?.behind === 3);
  checkS("event: the other open branch republished (behind 3 after the merge: the merge commit and feat/a's two)", !!e);
  r = await call("GET", `/v1/monorepos/${M}/repos/${repo}/branches?state=merged`, A);
  const mb = r.json?.branches?.[0];
  check("GET listBranches has the merge facts too", mb?.merged_by === `ana-${id}` && mb?.merged_machine === "ana-mbp" && mb?.forced === false && mb?.merged_agent === "agent-1");

  // ── the meta layer: connections, saves, tree, references ──
  const meta = new WebSocket(`${WS_}/v1/monorepos/${M}/meta/socket`, { headers: { authorization: `Bearer ${A}` } });
  const metaFrames = [];
  meta.onmessage = (m) => metaFrames.push(JSON.parse(m.data));
  await waitFor(() => meta.readyState === 1, 10_000);
  meta.send(JSON.stringify({ type: "hello", since: 0, machine: "ana-mbp", agent: "agent-2", client: "events-test/1" }));
  await waitFor(() => metaFrames.find((f) => f.type === "caught_up"), 10_000);
  e = await find(ev, (x) => x.kind === "machine.connected");
  checkS("event: machine.connected (connection row)", e?.collection === "connections" && e?.row?.machine === "ana-mbp" && e?.row?.agent === "agent-2" && e?.row?.client === "events-test/1" && !!e?.row?.connected_at);
  r = await call("GET", `/v1/monorepos/${M}/meta/status`, A);
  check("meta/status lists who is connected now", r.json?.connections?.some((x) => x.machine === "ana-mbp" && x.agent === "agent-2"), JSON.stringify(r.json?.connections));
  const bytes = Buffer.from("# Notes\nhello\n");
  meta.send(JSON.stringify({ type: "save", id: "s1", path: "notes/today.md", base_version: 0, sha: blobSha(bytes), bytes: bytes.toString("base64") }));
  e = await find(ev, (x) => x.kind === "meta.saved" && x.key === "notes/today.md");
  checkS("event: meta.saved (history entry row, no bytes)", e?.collection === "meta_files" && e?.op === "upsert" && e?.row?.size === bytes.length && e?.row?.agent === "agent-2" && !("bytes" in (e?.row ?? {})), scrub(JSON.stringify(e)).slice(0, 220));
  r = await call("GET", `/v1/monorepos/${M}/meta/tree`, A);
  check("meta/tree lists the file in one call", r.json?.files?.some((f) => f.path === "notes/today.md" && f.size === bytes.length && f.version >= 1), `${r.status} ${(r.json?.files ?? []).map((f) => f.path).join(",")}`);
  meta.close();
  e = await find(ev, (x) => x.kind === "machine.disconnected");
  checkS("event: machine.disconnected (op delete)", e?.op === "delete" && e?.row?.machine === "ana-mbp");

  // references arrive through a reviewed merge into the meta layer (.pando/** is protected)
  r = await call("GET", `/v1/monorepos/${M}/repos/meta`, A);
  const metaUrl = r.json?.clone_url;
  const mdir = join(work, "meta");
  mkdirSync(mdir);
  git(["init", "-q"], mdir);
  writeFileSync(join(mdir, "AGENTS.md"), "# meta\n");
  git(["add", "-A"], mdir);
  git(["commit", "-qm", "root"], mdir);
  git(["push", "-q", metaUrl, "main"], mdir, A);
  git(["checkout", "-qb", "ref"], mdir);
  mkdirSync(join(mdir, ".pando/references/research/infra"), { recursive: true });
  writeFileSync(join(mdir, ".pando/references/research/infra/oak.toml"), 'url = "https://github.com/example/oak.git"\nref = "refs/heads/main"\ncommit = "0123456789abcdef0123456789abcdef01234567"\n');
  git(["add", "-A"], mdir);
  git(["commit", "-qm", "Add a reference"], mdir);
  git(["push", "-q", metaUrl, "ref"], mdir, A);
  r = await call("POST", `/v1/monorepos/${M}/repos/meta/branches/ref/merge`, A);
  check("merge a reference pointer into the meta layer", r.status === 200, `${r.status} ${r.json?.error?.code ?? ""}`);
  e = await find(ev, (x) => x.kind === "meta.saved" && x.key === ".pando/references/research/infra/oak.toml");
  checkS("event: meta.saved for the merged pointer (source main)", e?.row?.source === "main");
  r = await call("GET", `/v1/monorepos/${M}/meta/references`, A);
  const ref = r.json?.references?.[0];
  check("meta/references lists it, parsed", ref?.path === "research/infra/oak" && ref?.url === "https://github.com/example/oak.git" && ref?.commit === "0123456789abcdef0123456789abcdef01234567", JSON.stringify(r.json));
  r = await call("GET", `/v1/monorepos/${M}/meta/tree?prefix=.pando/references/`, A);
  check("meta/tree?prefix= narrows to the references", r.json?.files?.length === 1);

  if (!STREAM) {
    r = await call("GET", `/v1/monorepos/${M}/events`, A);
    check("GET events answers 501 event_stream_on_hold while the stream is off", r.status === 501 && r.json?.error?.code === "event_stream_on_hold");
  }
  // ── reading back: JSON pages, replay, resync ──
  if (STREAM) {
  r = await call("GET", `/v1/monorepos/${M}/events?since=0&limit=500`, A);
  const all = r.json?.events ?? [];
  const seqsOk = all.every((x, i) => i === 0 || x.seq > all[i - 1].seq);
  checkS("GET events?since=0 returns every event in order", r.status === 200 && all.length >= 15 && seqsOk && r.json?.head === all[all.length - 1]?.seq, `${all.length} events, head ${r.json?.head}`);
  const live = eventsOf(ev);
  checkS("the socket got the same events as the JSON page", live.length === all.length && live.every((x, i) => x.seq === all[i].seq), `${live.length} vs ${all.length}`);
  r = await call("GET", `/v1/monorepos/${M}/events?limit=1`, A);
  checkS("GET events?limit=1 is the latest event (last activity)", r.json?.events?.length === 1 && r.json.events[0].seq === all[all.length - 1].seq);
  const mid = all[Math.floor(all.length / 2)].seq;
  const again = openEvents(M, A, mid);
  sockets.push(again);
  await waitFor(() => again.frames.find((f) => f.type === "caught_up"));
  const replay = eventsOf(again);
  checkS("a socket opened with ?since= replays what it missed, then caught_up", replay.length === all.filter((x) => x.seq > mid).length && replay[0]?.seq === mid + 1, `${replay.length} replayed`);
  const future = openEvents(M, A, all[all.length - 1].seq + 1000);
  sockets.push(future);
  const rs = await waitFor(() => future.frames.find((f) => f.type === "resync"));
  checkS("a ?since= ahead of the stream gets resync", rs?.head === all[all.length - 1].seq);
  for (const s of [ev, again, future]) s.ws.close();
  }
} catch (err) {
  check("no exception", false, String(err?.stack ?? err));
} finally {
  for (const s of sockets) {
    try {
      s.ws.close();
    } catch {}
  }
  for (const m of made) {
    const r = await call("DELETE", `/v1/monorepos/${m}?confirm=${m}`, A);
    check(`delete ${m}`, r.status === 204, `${r.status}`);
  }
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed${skipped ? `, ${skipped} skipped (stream on hold)` : ""}`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
