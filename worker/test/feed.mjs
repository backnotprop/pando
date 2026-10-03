// The home's activity feed (C25), end to end: real git through the door, real
// Artifacts, the pando-feed queue, per-person feeds. Against wrangler dev
// started with the test overrides (the split at 2 members instead of 100, a
// 0.5 s summary tick, and the test route):
//
//   npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to /tmp/feed-state
//   npx wrangler dev --port 8811 --persist-to /tmp/feed-state --var FEED_FANOUT_MAX:2 --var FEED_TICK_MS:500 --var FEED_TEST:1 --var FEED_RETRY_MS:200,400,600,800 > /tmp/feed-dev.log 2>&1
//   PANDO_URL=http://localhost:8811 PANDO_DEV_LOG=/tmp/feed-dev.log node test/feed.mjs
//
// Give every dev server its own --persist-to. Two wrangler dev servers on one
// folder's .wrangler/state open the same Durable Object databases: workerd
// then logs "internal error; reference = ...", SQLITE_BUSY and SQLITE_READONLY,
// and checks fail at random (reproduced 2026-10-03; no SQLite errors apart).
//
// With PANDO_DEV_LOG (the dev server's output), the run fails on any
// undisposed RPC result, 500, uncaught exception, Pando error line,
// SQLITE_BUSY or SQLITE_READONLY logged while it ran (workerd's bare
// "internal error" lines are counted: see the check at the end).
//
// Credentials stay in memory and are never printed. Git never reaches the
// macOS keychain. It deletes every monorepo it made.
import { spawnSync } from "node:child_process";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describeError, retryResetFetch } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8811").replace(/\/$/, "");

const WS_ = URL_.replace(/^http/, "ws");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>").replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<artifacts-token>");

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = (method, path, secret, body, headers = {}) => request(URL_, method, path, { secret, body, headers });

async function waitFor(pred, ms = 30_000, every = 200) {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await pred();

    if (v) return v;
    await sleep(every);
  }

  return null;
}

const work = mkdtempSync(join(tmpdir(), "pando-feed-"));

const gitAs = (secret) => (args, cwd, extraEnv = {}) => {
  const r = spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: secret ?? "", GIT_AUTHOR_NAME: "Ana", GIT_AUTHOR_EMAIL: "ana@pando.invalid", GIT_COMMITTER_NAME: "Ana", GIT_COMMITTER_EMAIL: "ana@pando.invalid", ...extraEnv },
  });

  return { ok: r.status === 0, out: scrub((r.stdout || "") + (r.stderr || "")) };
};

/** A socket that collects JSON frames. */
function openSocket(path, secret) {
  const frames = [];
  const ws = new WebSocket(WS_ + path, { headers: { authorization: `Bearer ${secret}` } });
  const s = { ws, frames, open: false, closed: null };
  ws.onopen = () => (s.open = true);
  ws.onmessage = (e) => {
    if (e.data === "pong") return frames.push({ type: "pong" });

    try {
      frames.push(JSON.parse(e.data));
    } catch {
      frames.push({ type: "unparsed" });
    }
  };

  ws.onclose = (e) => (s.closed = e.code);
  s.send = (o) => ws.send(JSON.stringify(o));
  s.ping = () => ws.send("ping");

  return s;
}

/** A raw upgrade, to read the HTTP status of a refused socket. */
function rawUpgrade(path, headers) {
  return new Promise((resolve) => {
    const u = new URL(URL_ + path);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });
    req.on("response", (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("upgrade", (res, sock) => {
      sock.destroy();
      resolve({ status: 101, body: "" });
    });
    req.on("error", (e) => resolve({ status: 0, body: String(e) }));
    req.end();
  });
}

const debugFeed = async (login) => (await call("GET", `/v1/_feed/test?login=${login}`, BOOT)).json;

const deliver = async (...messages) => (await call("POST", "/v1/_feed/test", BOOT, { deliver: messages })).json;

const pageAll = async (secret, q = "", limit = 200) => (await call("GET", `/v1/events?limit=${limit}${q}`, secret)).json;

const joinedAll = (login, names) => waitFor(async () => {
  const d = await debugFeed(login);

  return names.every((n) => d?.index?.some((r) => r.name === n && !r.pending)) ? d : null;
});

const DEV_LOG = process.env.PANDO_DEV_LOG ?? null;

const logLines = () => (DEV_LOG ? readFileSync(DEV_LOG, "utf8").split("\n") : []);

const logStart = logLines().length;

const keyDesc = (a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.monorepo_id !== b.monorepo_id ? (a.monorepo_id < b.monorepo_id ? 1 : -1) : b.seq - a.seq);

const id = Date.now().toString(36);

const [S, L, T, J, O] = ["fs", "fl", "ft", "fj", "fo"].map((p) => `${p}-${id}`);

const made = [];

const ID = {}; // each monorepo's id (namespaces: lines, rows and messages key on it)

const sockets = [];

const login = { ana: `ana-${id}`, bo: `bo-${id}`, cy: `cy-${id}` };

let A, B, C;

try {
  // ── Setup: three people; S small (2 members), L large (3 > the split of 2), T, J and O small ──
  A = (await call("POST", "/v1/users", BOOT, { login: login.ana, name: "Ana Lima", credential_name: "ana-mbp" })).json?.credential?.secret;
  B = (await call("POST", "/v1/users", BOOT, { login: login.bo, credential_name: "bo-mbp" })).json?.credential?.secret;
  C = (await call("POST", "/v1/users", BOOT, { login: login.cy, credential_name: "cy-mbp" })).json?.credential?.secret;
  check("three users", !!A && !!B && !!C);
  const clone = {};

  for (const m of [S, L, T, J, O]) {
    const r = await call("POST", "/v1/monorepos", A, { name: m, kind: "repo" });

    if (r.status === 201) made.push(m);
    ID[m] = r.json?.monorepo?.id;
    clone[m] = r.json?.repos?.[0]?.clone_url;
  }

  check("five plain repos made", made.length === 5);

  for (const [m, who] of [[S, "bo"], [L, "bo"], [L, "cy"]]) await call("PUT", `/v1/monorepos/${login.ana}/${m}/members/${login[who]}`, A, { role: "member" });
  let d = await joinedAll(login.ana, [S, L, T, J, O].map((m) => ID[m]));
  check("the creator's feed joins each new monorepo (a member message on create)", !!d, JSON.stringify(d?.index?.map((r) => [r.name.slice(0, 2), r.pending, r.large])));
  d = await waitFor(async () => {
    const x = await debugFeed(login.ana);

    return x?.index?.find((r) => r.name === ID[L])?.large === true ? x : null;
  }, 15_000);
  check("the split: L (3 members, over 2) is large in its owner's feed; S (2) is not", d?.index?.find((r) => r.name === ID[L])?.large === true && d?.index?.find((r) => r.name === ID[S])?.large === false);

  // ── The person's live socket ──
  const live = openSocket("/v1/events", A);
  sockets.push(live);
  await waitFor(() => live.open, 10_000);
  live.send({ type: "hello", since: 0 });
  const caught = await waitFor(() => live.frames.find((f) => f.type === "caught_up"), 10_000);
  check("the live socket answers hello with caught_up and the landed number", Number.isInteger(caught?.landed), JSON.stringify(caught));
  live.ping();
  check("ping gets pong", !!(await waitFor(() => live.frames.find((f) => f.type === "pong"), 5000)));

  // Cookie sockets: the Origin rule applies (403 bad_origin before the cookie is even read).
  let u = await rawUpgrade("/v1/events", { cookie: "__Host-pando_session=pando_" + "0".repeat(40), origin: "https://evil.example" });
  check("a cookie socket from another origin is refused (403 bad_origin)", u.status === 403 && /bad_origin/.test(u.body), `${u.status}`);
  u = await rawUpgrade("/v1/events", { cookie: "__Host-pando_session=pando_" + "0".repeat(40), origin: URL_ });
  check("a cookie socket from Pando's origin reaches the credential check (401 for an unknown session)", u.status === 401, `${u.status}`);
  u = await rawUpgrade("/v1/events", {});
  check("no credential: 401", u.status === 401, `${u.status}`);

  // ── A push in S: commit count, head title, pushed_machine, co_authors ──
  const git = gitAs(A);
  const src = join(work, "s");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# s\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  check("push S main", git(["push", "-q", clone[S], "main"], src).ok);
  let e = await waitFor(() => live.frames.find((f) => f.type === "event" && f.event?.monorepo_id === ID[S] && f.event.kind === "push"), 30_000);
  check("a line names its monorepo as owner/name (monorepo) and by its id (monorepo_id)", e?.event?.monorepo === `${login.ana}/${S}` && /^m_[0-9a-f]{16}$/.test(e?.event?.monorepo_id ?? ""), `${e?.event?.monorepo} ${e?.event?.monorepo_id}`);
  check("main's first push reaches the live socket with its commit count (1) and title", e?.event?.summary?.commits === 1 && e.event.summary.head_title === "first" && e.event.branch === "main" && e.event.machine === "ana-mbp" && e.event.actor === login.ana, JSON.stringify(e?.event?.summary));
  git(["checkout", "-qb", "feat/x"], src);
  writeFileSync(join(src, "x.txt"), "x\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "Add x"], src);
  writeFileSync(join(src, "x.txt"), "x\ny\n");
  git(["commit", "-qam", "More x\n\nWhy it matters.\n\nCo-authored-by: Claude <noreply@anthropic.com>\nPando-Machine: ana-mbp"], src);
  check("push S feat/x (2 commits)", git(["push", "-q", clone[S], "feat/x"], src).ok);
  const headX = git(["rev-parse", "HEAD"], src).out.trim();
  e = await waitFor(() => live.frames.find((f) => f.type === "event" && f.event?.monorepo_id === ID[S] && f.event.kind === "branch.opened"), 30_000);
  check("branch.opened carries commits 2 and the head commit's title (from the facts job)", e?.event?.summary?.commits === 2 && e.event.summary.head_title === "More x" && e.event.branch === "feat/x" && e.event.repo === S && e.event.repo_path === ".", JSON.stringify(e?.event));
  check("feed lines carry no agent field", e && !("agent" in e.event));
  let r = await call("GET", `/v1/monorepos/${login.ana}/${S}/repos/${S}/branches/feat%2Fx`, A);
  check("Branch.pushed_machine is the pushing credential's name", r.json?.pushed_machine === "ana-mbp", JSON.stringify(r.json?.pushed_machine));
  r = await call("GET", `/v1/monorepos/${login.ana}/${S}/repos/${S}/branches/feat%2Fx/commits`, A);
  check("Commit.co_authors from Co-authored-by", JSON.stringify(r.json?.commits?.[0]?.co_authors) === JSON.stringify([{ name: "Claude", email: "noreply@anthropic.com" }]) && JSON.stringify(r.json?.commits?.[1]?.co_authors) === "[]", JSON.stringify(r.json?.commits?.map((c) => c.co_authors)));
  d = await waitFor(async () => {
    const x = await debugFeed(login.bo);

    return (x?.pointers?.[ID[S]] ?? 0) >= 2 ? x : null;
  });
  check("fan-out: S (2 members) is copied into bo's feed", !!d, JSON.stringify(d?.pointers));

  // ── T: a second monorepo on the same socket ──
  await call("PUT", `/v1/monorepos/${login.ana}/${T}/worktrees/wt_t1_${id}`, A, { repo: ".", branch: "feat/t", path: "worktrees/feat-t", machine: "ana-mbp", kind: "sparse" });
  e = await waitFor(() => live.frames.find((f) => f.type === "event" && f.event?.monorepo_id === ID[T] && f.event.kind === "worktree.reported"), 20_000);
  check("one live socket gets events from two monorepos (S and T)", !!e && live.frames.some((f) => f.event?.monorepo_id === ID[S]), JSON.stringify(e?.event?.summary));
  await call("PUT", `/v1/monorepos/${login.ana}/${T}/worktrees/wt_t1_${id}`, A, { repo: ".", branch: "feat/t", path: "worktrees/feat-t", machine: "ana-mbp", kind: "sparse" });
  await sleep(1500);
  check("a repeated worktree report is not a second line", live.frames.filter((f) => f.event?.monorepo_id === ID[T] && f.event.kind === "worktree.reported").length === 1);

  // ── L (large): fan-in on read, its own socket for live ──
  const lsock = openSocket(`/v1/monorepos/${login.ana}/${L}/events?topics=feed`, A);
  sockets.push(lsock);
  await waitFor(() => lsock.open, 10_000);
  await call("PUT", `/v1/monorepos/${login.ana}/${L}/worktrees/wt_l1_${id}`, A, { repo: ".", branch: "feat/l", path: "worktrees/feat-l", machine: "ana-mbp", kind: "sparse" });
  e = await waitFor(() => lsock.frames.find((f) => f.type === "feed" && f.event?.kind === "worktree.reported"), 10_000);
  check("a large monorepo's socket with topics=feed gets feed lines", !!e, JSON.stringify(e?.event?.monorepo));
  await sleep(1500);
  check("a large monorepo's lines do not reach the person's socket", !live.frames.some((f) => f.type === "event" && f.event?.monorepo_id === ID[L]));
  const dA = await debugFeed(login.ana);
  check("no feed holds L's lines (no fan-out above the split)", !dA.pointers[ID[L]] && !(await debugFeed(login.bo)).pointers[ID[L]], JSON.stringify(dA.pointers));
  let p = await pageAll(A);
  check("fan-in: GET /v1/events includes L's line, read from L's log", p?.events?.some((x) => x.monorepo_id === ID[L] && x.kind === "worktree.reported") && p.from_logs === false, JSON.stringify(p?.events?.map((x) => x.monorepo.slice(0, 2) + ":" + x.kind)));
  p = await pageAll(A, `&in=${login.ana}/${L}`);
  check("in=<large monorepo> reads its log", p?.events?.length === 1 && p.events[0].monorepo_id === ID[L]);

  // ── Pages: the cursor is stable, newest first, no repeats ──
  for (let i = 0; i < 3; i++) await call("PUT", `/v1/monorepos/${login.ana}/${J}/worktrees/wt_j${i}_${id}`, A, { repo: ".", branch: `feat/j${i}`, path: `worktrees/j${i}`, machine: "ana-mbp", kind: "sparse" });
  await waitFor(async () => (await debugFeed(login.ana)).pointers[ID[J]] === 3);
  const full = (await pageAll(A)).events;
  const walked = [];
  let cursor = null;

  for (let i = 0; i < 20; i++) {
    const pg = (await call("GET", `/v1/events?limit=2${cursor ? `&cursor=${cursor}` : ""}`, A)).json;
    walked.push(...pg.events);
    cursor = pg.next;

    if (!cursor) break;
  }

  const sorted = [...full].sort(keyDesc);
  check("pages of 2 walk the same lines as one page, newest first, each once", walked.length === full.length && walked.every((x, i) => x.monorepo_id === full[i].monorepo_id && x.seq === full[i].seq) && JSON.stringify(full) === JSON.stringify(sorted), `${walked.length} vs ${full.length}`);
  r = await call("GET", "/v1/events?cursor=nope", A);
  check("a bad cursor is a 400", r.status === 400);
  r = await call("GET", `/v1/events?in=${login.ana}/${T}:meta`, A);
  check("in= takes one monorepo only (the home narrows by monorepo)", r.status === 400);
  r = await call("GET", `/v1/events?in=${login.ana}/${T}`, B);
  check("in=<a monorepo that is not yours> is a 404", r.status === 404, `${r.status}`);
  r = await call("GET", `/v1/events?in=${login.ana}/${T}`, A);
  check("in=<monorepo> narrows the log", r.json?.events?.length >= 1 && r.json.events.every((x) => x.monorepo_id === ID[T]));

  // ── Join backfill: bo joins J, which already has 3 lines ──
  await call("PUT", `/v1/monorepos/${login.ana}/${J}/members/${login.bo}`, A, { role: "member" });
  d = await waitFor(async () => {
    const x = await debugFeed(login.bo);

    return x?.index?.some((i) => i.name === ID[J] && !i.pending) && x.pointers[ID[J]] === 3 ? x : null;
  });
  check("join: bo's feed gets J's 3 earlier lines (backfill)", !!d, JSON.stringify(d?.pointers));
  r = await call("GET", `/v1/events?in=${login.ana}/${J}`, B);
  check("join: bo's log shows them", r.json?.events?.length === 3 && r.json.from_logs === false, JSON.stringify(r.json?.events?.map((x) => x.summary?.path)));
  // ── Leave ──
  await call("DELETE", `/v1/monorepos/${login.ana}/${J}/members/${login.bo}`, A);
  d = await waitFor(async () => {
    const x = await debugFeed(login.bo);

    return !x?.index?.some((i) => i.name === ID[J]) && !x.pointers[ID[J]] ? x : null;
  });
  check("leave: bo's index row and J's lines are gone", !!d);
  r = await call("GET", `/v1/events?in=${login.ana}/${J}`, B);
  check("leave: bo cannot read J's log any more", r.status === 404, `${r.status}`);
  r = await call("GET", "/v1/monorepos?summary=1", B);
  check("leave: J is not on bo's home", r.status === 200 && !r.json?.monorepos?.some((m) => m.name === J) && r.json.monorepos.some((m) => m.name === S));

  // ── Out-of-order and repeated queue deliveries (run in a chosen order through the test route) ──
  const base = Date.now() - 3_600_000;
  const at = (s) => new Date(base + s * 1000).toISOString();
  const line = (seq, s, title) => ({ monorepo: ID[O], seq, at: at(s), kind: "push", repo: O, repo_path: ".", branch: "ooo", actor: login.ana, machine: "ana-mbp", summary: { commits: 1, head_title: title } });
  const before = live.frames.length;
  await deliver(
    { type: "events", monorepo: ID[O], members: [login.ana], events: [line(100003, 3, "three")] },
    { type: "events", monorepo: ID[O], members: [login.ana], events: [line(100001, 1, "one")] },
    { type: "events", monorepo: ID[O], members: [login.ana], events: [line(100002, 2, "two"), line(100003, 3, "three again")] },
    { type: "events", monorepo: ID[O], members: [login.ana], events: [line(100002, 2, "two")] },
  );
  p = await pageAll(A, `&in=${login.ana}/${O}`);
  const ooo = p.events.filter((x) => x.seq > 100000);
  check("out of order: lines delivered 3, 1, (2, 3), 2 read 3, 2, 1, each once, the later copy winning", ooo.map((x) => x.seq).join(",") === "100003,100002,100001" && ooo[0].summary.head_title === "three again", ooo.map((x) => `${x.seq}:${x.summary.head_title}`).join(" "));
  const landedFrames = live.frames.slice(before).filter((f) => f.type === "event" && f.event.seq > 100000);
  check("live frames keep each line's landed number when a copy repeats", landedFrames.length >= 3 && new Set(landedFrames.map((f) => `${f.event.seq}:${f.landed}`)).size === 3, landedFrames.map((f) => `${f.event.seq}@${f.landed}`).join(" "));
  const sumAt = (ms, w) => ({ type: "summary", monorepo: ID[O], members: [login.ana], summary: { last_activity_at: at(3), worktrees_active: w, machines_active: 1, needs: { ready: 0, conflicts: 0, failing: 0 }, members: 1, large: false, at: new Date(Date.now() + ms).toISOString() }, needs_changed: [], needs_more: false });
  await deliver(sumAt(3_600_000, 7), sumAt(-60_000, 3));
  r = await call("GET", "/v1/monorepos?summary=1", A);
  check("out of order: an older summary arriving late is dropped", r.json?.monorepos?.find((m) => m.name === O)?.worktrees_active === 7, JSON.stringify(r.json?.monorepos?.find((m) => m.name === O)));
  await deliver({ type: "member", monorepo: ID[O], login: login.cy });
  check("a member message for a non-member (a stale join) leaves cy's feed without O", !(await debugFeed(login.cy)).index.some((i) => i.name === ID[O]));
  await deliver({ type: "events", monorepo: ID[T], members: [login.cy], events: [{ ...line(100009, 9, "x"), monorepo: ID[T] }] });
  check("lines for a monorepo not in the person's index are dropped", !(await debugFeed(login.cy)).pointers[ID[T]]);
  const n0 = (await debugFeed(login.ana)).pointers[ID[O]];
  await deliver({ type: "member", monorepo: ID[O], login: login.ana });
  check("a repeated join keeps the lines it has", (await debugFeed(login.ana)).pointers[ID[O]] === n0, `${n0}`);

  // ── The outbox (C25-LIVE-HOME.md): retries, the dead row, a crash mid-drain ──
  const outbox = async (m) => (await call("GET", `/v1/_feed/test?monorepo=${m}`, BOOT)).json?.outbox;
  const arm = (set) => call("POST", "/v1/_feed/test", BOOT, { outbox: { monorepo: ID[T], ...set } });
  const report = (wid) => call("PUT", `/v1/monorepos/${login.ana}/${T}/worktrees/${wid}`, A, { repo: ".", branch: wid, path: `worktrees/${wid}`, machine: "ana-mbp", kind: "sparse" });
  const lineFor = (wid, ms = 10_000) => waitFor(() => live.frames.find((f) => f.type === "event" && f.event?.monorepo_id === ID[T] && f.event.summary?.worktree === wid), ms);
  const ptrT = async () => (await debugFeed(login.ana)).pointers[ID[T]] ?? 0;
  {
    // A line, the normal way: at once.
    let t0 = Date.now();
    await report(`wo_now_${id}`);
    check("outbox: a line reaches the person's socket at once (one RPC, no queue)", !!(await lineFor(`wo_now_${id}`, 5000)), `${Date.now() - t0} ms`);
    // Two failed drains, then delivered on the third try (retries 200 ms, 400 ms on this server).
    await arm({ fail: 2 });
    t0 = Date.now();
    await report(`wo_retry_${id}`);
    const tries = await waitFor(async () => (await outbox(ID[T]))?.rows?.find((r) => r.attempts >= 1), 5000);
    let got = await lineFor(`wo_retry_${id}`, 10_000);
    const ms = Date.now() - t0;
    check("outbox: two failed drains are tried again on the schedule, and the line arrives", !!tries && !!got && ms >= 500, `${ms} ms; error "${tries?.error}"`);
    check("outbox: the delivered row is gone", !!(await waitFor(async () => (await outbox(ID[T]))?.live === 0, 5000)));
    // Every try fails: dead after the 5th, kept, never in the feed.
    const before = await ptrT();
    await arm({ fail: 50 });
    await report(`wo_dead_${id}`);

    const dead = await waitFor(async () => {
      const o = await outbox(ID[T]);

      return o?.dead >= 1 && o.live === 0 ? o : null;
    }, 15_000);

    await arm({ fail: 0 });
    const row = dead?.rows?.find((r) => r.dead_at);
    check("outbox: a row that fails every try is dead after the 5th and kept", row?.attempts === 5 && /failed drain/.test(row.error ?? ""), JSON.stringify(row));
    check("outbox: a dead row's line is not in the feed", (await ptrT()) === before && !live.frames.some((f) => f.event?.summary?.worktree === `wo_dead_${id}`));
    // The object dies after the change is acknowledged and before its drain call: the alarm drains it.
    await arm({ crash: "before" });
    t0 = Date.now();
    let r = await report(`wo_crash1_${id}`);
    const logged = (await call("GET", `/v1/monorepos/${login.ana}/${T}/events?limit=20`, A)).json?.events?.some((e) => e.kind === "worktree.reported" && e.key === `wo_crash1_${id}`);
    check("crash before the drain: the change was recorded and acknowledged", r.status === 200 && logged, `${r.status}`);
    got = await lineFor(`wo_crash1_${id}`, 15_000);
    check("crash before the drain: the line still arrives (the alarm set with the row drains it)", !!got, `${Date.now() - t0} ms`);
    // The object dies after its drain call delivered, before deleting the rows: the retry delivers again, the feed keeps one copy.
    const n0 = await ptrT();
    await arm({ crash: "after" });
    r = await report(`wo_crash2_${id}`);
    got = await lineFor(`wo_crash2_${id}`, 15_000);
    const drained = await waitFor(async () => (await outbox(ID[T]))?.live === 0, 15_000);
    await sleep(1000);
    check("crash after the drain: delivered once to the socket's feed, redelivered without a second copy, outbox empty", r.status === 200 && !!got && !!drained && (await ptrT()) === n0 + 1, `${n0} -> ${await ptrT()}`);
  }

  // ── A monorepo's own `feed` topic: every line, in order, and a reconnect replays what it missed ──
  {
    const tsock = (q) => openSocket(`/v1/monorepos/${login.ana}/${T}/events?topics=feed${q}`, A);
    const s1 = tsock("");
    sockets.push(s1);
    const cu1 = await waitFor(() => s1.frames.find((f) => f.type === "caught_up"), 10_000);
    const wids = Array.from({ length: 8 }, (_, k) => `wf${k}_${id}`);
    const put = (w) => call("PUT", `/v1/monorepos/${login.ana}/${T}/worktrees/${w}`, A, { repo: ".", branch: w, path: `worktrees/${w}`, machine: "ana-mbp", kind: "sparse" });

    for (const w of wids.slice(0, 5)) await put(w);

    const lines1 = await waitFor(() => {
      const f = s1.frames.filter((x) => x.type === "feed" && wids.includes(x.event?.summary?.worktree));

      return f.length >= 5 ? f : null;
    }, 10_000);

    const ns = (lines1 ?? []).map((f) => f.n);
    check("feed topic: caught_up names the last line number, then every line arrives once, numbered in order",
      Number.isInteger(cu1?.feed_n) && lines1?.length === 5 && ns.every((n, i) => i === 0 || n === ns[i - 1] + 1) && ns[0] === cu1.feed_n + 1, `${cu1?.feed_n} then ${ns.join(",")}`);
    const lastN = Math.max(...s1.frames.filter((x) => x.type === "feed").map((f) => f.n));
    s1.ws.close();
    await waitFor(() => s1.closed !== null, 5000);

    for (const w of wids.slice(5)) await put(w);
    const s2 = tsock(`&feed_since=${lastN}`);
    sockets.push(s2);
    const cu2 = await waitFor(() => s2.frames.find((f) => f.type === "caught_up"), 10_000);
    const replayed = s2.frames.filter((x) => x.type === "feed");
    check("feed topic: a socket that reconnects with feed_since gets exactly the lines it missed, then caught_up",
      replayed.length === 3 && replayed.map((f) => f.event.summary?.worktree).join() === wids.slice(5).join() && cu2?.feed_n === lastN + 3 && s2.frames.indexOf(cu2) > s2.frames.indexOf(replayed[2]),
      `${replayed.map((f) => `${f.n}:${f.event.summary?.worktree}`).join(" ")} then ${cu2?.feed_n}`);
    const s3 = tsock(`&feed_since=${10 ** 9}`);
    sockets.push(s3);
    check("feed topic: a feed_since ahead of the monorepo gets feed_resync", !!(await waitFor(() => s3.frames.find((f) => f.type === "feed_resync"), 5000)));
  }

  // ── Presence: the follower socket's hello ──
  const mw = openSocket(`/v1/monorepos/${login.ana}/${S}/events?topics=kind:machine.updated`, A);
  sockets.push(mw);
  await waitFor(() => mw.open, 10_000);
  const f1 = openSocket(`/v1/monorepos/${login.ana}/${S}/events?topics=main`, A);
  const f2 = openSocket(`/v1/monorepos/${login.ana}/${S}/events?topics=main`, B);
  sockets.push(f1, f2);
  await waitFor(() => f1.open && f2.open, 10_000);
  f1.send({ type: "hello", machine: "m1", worktrees: ["w1", "w2"] });
  f2.send({ type: "hello", machine: "m2", worktrees: ["w3"] });
  const ok1 = await waitFor(() => f1.frames.find((f) => f.type === "hello_ok"), 5000);
  check("hello gets hello_ok with counts", ok1?.machine === "m1" && ok1?.worktrees === 2, JSON.stringify(ok1));
  f1.send({ type: "hello", worktrees: ["bad id!"] });
  check("a bad hello gets an error frame", !!(await waitFor(() => f1.frames.find((f) => f.type === "error"), 5000)));

  const presence = async (want) => waitFor(async () => {
    const m = (await call("GET", "/v1/monorepos?summary=1", A)).json?.monorepos?.find((x) => x.name === S);

    return m && m.machines_active === want[0] && m.worktrees_active === want[1] ? m : null;
  }, 15_000);

  check("presence: 2 machines and 3 worktrees with open follower sockets", !!(await presence([2, 3])));
  f1.send({ type: "hello", machine: "m1", worktrees: ["w1", "w2", "w4"] });
  check("presence: a hello update (a worktree added) counts", !!(await presence([2, 4])));
  // ── The Machines tab: one row per (login, credential) ──
  const machines = async () => (await call("GET", `/v1/monorepos/${login.ana}/${S}/machines`, A)).json?.machines ?? [];
  const mrows = await machines();
  const anaRow = mrows.find((x) => x.login === login.ana);
  const boRow = mrows.find((x) => x.login === login.bo);
  check("machines: a row per machine, named by its credential, connected with its worktrees", anaRow?.name === "ana-mbp" && anaRow.connected && JSON.stringify(anaRow.worktrees.map((w) => w.id)) === JSON.stringify(["w1", "w2", "w4"]) && boRow?.name === "bo-mbp" && boRow.connected && boRow.worktrees[0]?.id === "w3" && !!anaRow.credential_id && anaRow.credential_id !== boRow.credential_id, JSON.stringify(mrows.map((x) => [x.login.slice(0, 3), x.name, x.connected, x.worktrees.map((w) => w.id).join("+")])));
  check("machines: latest activity first; a machine that only connected has none", mrows[0]?.login === login.ana && ["push", "branch.opened", "merged", "status"].includes(anaRow?.last_activity?.kind) && anaRow.last_activity.repo_path === "." && boRow?.last_activity === null, JSON.stringify(anaRow?.last_activity)?.slice(0, 160));

  if (["push", "branch.opened"].includes(anaRow?.last_activity?.kind)) check("machines: a push's row carries its commit count once the facts job ran", Number.isInteger(anaRow.last_activity.summary?.commits), JSON.stringify(anaRow.last_activity.summary));
  check("machine.updated: a new row and a connect are published", !!(await waitFor(() => mw.frames.some((f) => f.kind === "machine.updated" && f.row?.login === login.bo && f.row.connected), 5000)) && mw.frames.some((f) => f.kind === "machine.updated" && f.row?.login === login.ana && f.collection === "machines"));
  const anaPublished = mw.frames.filter((f) => f.row?.login === login.ana).length;
  await call("PUT", `/v1/monorepos/${login.ana}/${S}/worktrees/wm_${id}`, A, { repo: ".", branch: "feat/m", path: "worktrees/feat-m", machine: "ana-mbp", kind: "sparse" });
  const moved = await waitFor(async () => (await machines()).find((x) => x.login === login.ana && x.last_activity?.kind === "worktree.reported"), 5000);
  await sleep(500);
  check("machines: activity moves the row at once, and is not republished within a minute", !!moved && mw.frames.filter((f) => f.row?.login === login.ana).length === anaPublished, `${anaPublished} -> ${mw.frames.filter((f) => f.row?.login === login.ana).length}`);
  const page = (await call("GET", `/v1/monorepos/${login.ana}/${S}/events?limit=50`, A)).json?.events ?? [];
  check("events never carry the credential behind them (via)", page.length > 0 && page.every((x) => !("via" in x)));
  f2.ws.close();
  check("presence: a closed socket stops counting", !!(await presence([1, 3])));
  check("machines: its machine's last socket closing disconnects it, and is published", !!(await waitFor(() => mw.frames.some((f) => f.kind === "machine.updated" && f.row?.login === login.bo && !f.row.connected), 5000)) && (await machines()).find((x) => x.login === login.bo)?.connected === false);
  check("the person's socket gets summary frames", live.frames.some((f) => f.type === "summary" && f.monorepo_id === ID[S]));

  // ── Needs you, from stored facts ──
  let n = await waitFor(async () => {
    const x = (await call("GET", "/v1/branches?state=open&needs=ready", A)).json;

    return x?.branches?.some((b) => b.monorepo_id === ID[S] && b.branch === "feat/x") ? x : null;
  });

  const bx = n?.branches?.find((b) => b.branch === "feat/x");
  check("needs you: feat/x is ready (clean against main, checks pass), with its machine", bx?.state === "ready" && bx.pushed_machine === "ana-mbp" && bx.author === login.ana && bx.repo_path === ".", JSON.stringify(bx));
  await call("POST", `/v1/monorepos/${login.ana}/${S}/repos/${S}/statuses/${headX}`, A, { state: "pending", context: "ci" });
  await call("POST", `/v1/monorepos/${login.ana}/${S}/repos/${S}/statuses/${headX}`, A, { state: "pending", context: "ci" });
  await call("POST", `/v1/monorepos/${login.ana}/${S}/repos/${S}/statuses/${headX}`, A, { state: "failure", context: "ci", description: "2 tests failed" });
  n = await waitFor(async () => {
    const x = (await call("GET", "/v1/branches?state=open&needs=failing", A)).json;

    return x?.branches?.some((b) => b.branch === "feat/x") ? x : null;
  });
  check("needs you: a failed check moves feat/x to failing", n?.branches?.find((b) => b.branch === "feat/x")?.checks?.failing?.[0] === "ci");

  const sm = await waitFor(async () => {
    const m = (await call("GET", "/v1/monorepos?summary=1", A)).json?.monorepos?.find((x) => x.name === S);

    return m?.needs?.failing === 1 && m.needs.ready === 0 ? m : null;
  }, 15_000);

  check("the summary line counts it (failing 1, ready 0)", !!sm, JSON.stringify(sm?.needs));
  check("the person's socket gets a needs frame for feat/x", !!(await waitFor(() => live.frames.find((f) => f.type === "needs" && f.monorepo_id === ID[S] && f.changed?.some((c) => c.branch === "feat/x" && c.state === "failing")), 10_000)));
  p = await pageAll(A, `&in=${login.ana}/${S}`);
  const st = p.events.filter((x) => x.kind === "status");
  check("status lines: only changes of state (pending once, then failure with a duration)", st.length === 2 && st[0].summary.state === "failure" && Number.isInteger(st[0].summary.duration_s) && st[0].branch === "feat/x", st.map((x) => `${x.summary.state}:${x.summary.duration_s}`).join(" "));
  // A conflict: c1 lands on main, c2 changed the same line differently.
  git(["checkout", "-q", "main"], src);
  git(["checkout", "-qb", "c1"], src);
  writeFileSync(join(src, "README.md"), "# s, one\n");
  git(["commit", "-qam", "c1"], src);
  git(["checkout", "-q", "main"], src);
  git(["checkout", "-qb", "c2"], src);
  writeFileSync(join(src, "README.md"), "# s, two\n");
  git(["commit", "-qam", "c2"], src);
  git(["push", "-q", clone[S], "c1", "c2"], src);
  r = await call("POST", `/v1/monorepos/${login.ana}/${S}/repos/${S}/branches/c1/merge`, A, {});
  check("merge c1", r.status === 200, `${r.status} ${r.json?.error?.code ?? ""}`);
  n = await waitFor(async () => {
    const x = (await call("GET", `/v1/branches?state=open&needs=conflicts&in=${login.ana}/${S}`, A)).json;

    return x?.branches?.some((b) => b.branch === "c2") ? x : null;
  }, 45_000);
  check("needs you: c2 conflicts with main", n?.branches?.find((b) => b.branch === "c2")?.state === "conflicts");
  e = await waitFor(() => live.frames.find((f) => f.type === "event" && f.event?.monorepo_id === ID[S] && f.event.kind === "merged"), 10_000);
  check("the merge is a line, with its merge commit", !!e?.event?.summary?.merge_commit && e.event.branch === "c1");
  r = await call("GET", "/v1/branches?state=merged", A);
  check("GET /v1/branches answers state=open only", r.status === 400);

  // ── The split, crossing it: cy joins S (3 members, large), then leaves (small again) ──
  await call("PUT", `/v1/monorepos/${login.ana}/${S}/members/${login.cy}`, A, { role: "member" });
  d = await waitFor(async () => {
    const x = await debugFeed(login.ana);

    return x.index.find((i) => i.name === ID[S])?.large && !x.pointers[ID[S]] ? x : null;
  }, 20_000);
  check("S over the split: large in ana's feed, its copied lines dropped", !!d);
  p = await pageAll(A, `&in=${login.ana}/${S}`);
  check("S's lines still read, from its log", p.events.some((x) => x.kind === "branch.opened" && x.branch === "feat/x"));
  await call("DELETE", `/v1/monorepos/${login.ana}/${S}/members/${login.cy}`, A);
  d = await waitFor(async () => {
    const x = await debugFeed(login.ana);
    const row = x.index.find((i) => i.name === ID[S]);

    return row && !row.large && row.covered_after ? x : null;
  }, 20_000);
  check("S under the split again: small, copied from now on (older lines from its log)", !!d);
  p = await pageAll(A, `&in=${login.ana}/${S}`);
  check("S's history reads in full after the round trip", p.events.some((x) => x.kind === "branch.opened" && x.branch === "feat/x") && p.from_logs === true);

  // ── Replay on reconnect: two lines land while a second socket is away ──
  const h0 = Math.max(0, ...live.frames.filter((f) => f.landed).map((f) => f.landed));

  for (const k of [1, 2]) await call("PUT", `/v1/monorepos/${login.ana}/${T}/worktrees/wt_r${k}_${id}`, A, { repo: ".", branch: `feat/r${k}`, path: `worktrees/r${k}`, machine: "ana-mbp", kind: "sparse" });
  await waitFor(() => live.frames.filter((f) => f.type === "event" && f.landed > h0).length >= 2, 15_000);
  const again = openSocket("/v1/events", A);
  sockets.push(again);
  await waitFor(() => again.open, 10_000);
  again.send({ type: "hello", since: h0 });
  const cu = await waitFor(() => again.frames.find((f) => f.type === "caught_up"), 10_000);
  const replayed = again.frames.filter((f) => f.type === "event");
  check("hello {since} replays what landed after it, then caught_up", cu && replayed.length === 2 && replayed.every((f) => f.landed > h0 && f.event.monorepo_id === ID[T]), `${replayed.map((f) => f.landed).join(",")} then ${cu?.landed}`);
  again.send({ type: "hello", since: 10 ** 9 });
  check("hello with a since ahead of the feed gets resync", !!(await waitFor(() => again.frames.find((f) => f.type === "resync"), 5000)));

  // ── Past the window: trim ana's feed to 0 days; pages read every monorepo's log ──
  const beforeTrim = (await pageAll(A)).events.map((x) => `${x.monorepo_id}/${x.seq}`);
  const tr = (await call("POST", "/v1/_feed/test", BOOT, { trim: { login: login.ana, days: 0 } })).json;
  p = await pageAll(A);
  const afterTrim = p.events.map((x) => `${x.monorepo_id}/${x.seq}`);
  const realBefore = beforeTrim.filter((k) => !k.startsWith(`${ID[O]}/1000`));
  check("past the window: the same lines, read from the monorepos' logs (from_logs)", tr.dropped > 0 && p.from_logs === true && realBefore.every((k) => afterTrim.includes(k)), `dropped ${tr.dropped}; ${realBefore.length} lines; missing ${realBefore.filter((k) => !afterTrim.includes(k)).length}`);

  // ── Deleting a monorepo with followers and a feed attached leaves nothing behind ──
  for (let round = 1; round <= 3; round++) {
    const D = `fd${round}-${id}`;
    let rd = await call("POST", "/v1/monorepos", A, { name: D, kind: "repo" });

    if (rd.status === 201) made.push(D);
    ID[D] = rd.json?.monorepo?.id;
    await call("PUT", `/v1/monorepos/${login.ana}/${D}/members/${login.bo}`, A, { role: "member" });
    await waitFor(async () => (await debugFeed(login.ana)).index.some((i) => i.name === ID[D] && !i.pending), 15_000);
    const fa = openSocket(`/v1/monorepos/${login.ana}/${D}/events?topics=main`, A);
    const fb = openSocket(`/v1/monorepos/${login.ana}/${D}/events?topics=main`, B);
    await waitFor(() => fa.open && fb.open, 10_000);
    fa.send({ type: "hello", machine: "ma", worktrees: ["d1", "d2"] });
    fb.send({ type: "hello", machine: "mb", worktrees: ["d3"] });

    for (let k = 0; k < 3; k++) await call("PUT", `/v1/monorepos/${login.ana}/${D}/worktrees/wd${k}_${id}`, A, { repo: ".", branch: `d${k}`, path: `worktrees/d${k}`, machine: "ma", kind: "sparse" });
    await waitFor(() => live.frames.some((f) => f.event?.monorepo_id === ID[D]), 10_000);
    rd = await call("DELETE", `/v1/monorepos/${login.ana}/${D}?confirm=${login.ana}/${D}`, A);
    made.splice(made.indexOf(D), 1);
    const closed = await waitFor(() => fa.closed === 4404 && fb.closed === 4404, 10_000);

    const left = await waitFor(async () => {
      const [a, b] = [await debugFeed(login.ana), await debugFeed(login.bo)];

      return !a.index.some((i) => i.name === ID[D]) && !a.pointers[ID[D]] && !b.index.some((i) => i.name === ID[D]) && !b.pointers[ID[D]];
    }, 15_000);

    check(`delete with followers and feeds attached (${round} of 3): sockets closed 4404, both feeds left`, rd.status === 204 && !!closed && !!left, `${rd.status} ${fa.closed}/${fb.closed}`);
  }

  check("the person's socket got a left frame for a deleted monorepo", live.frames.some((f) => f.type === "left" && f.monorepo === `${login.ana}/fd1-${id}` && f.monorepo_id === ID[`fd1-${id}`]));

  // ── The home's list ──
  r = await call("GET", "/v1/monorepos?summary=1", A);
  const ms = r.json?.monorepos ?? [];
  const ordered = ms.every((m, i) => i === 0 || (ms[i - 1].last_activity_at ?? "") >= (m.last_activity_at ?? ""));
  check("GET /v1/monorepos?summary=1: every monorepo, most recently active first, with its line", ms.length === 5 && ordered && ms.every((m) => m.role && "machines_active" in m && "needs" in m), ms.map((m) => `${m.name.slice(0, 2)}:${m.last_activity_at?.slice(11, 19)}`).join(" "));
  {
    // The line's "N projects, M open branches", from the monorepo's own records: S has feat/x and c2 open (c1 merged), T none.
    const line = await waitFor(async () => {
      const list = (await call("GET", "/v1/monorepos?summary=1", A)).json?.monorepos ?? [];
      const s1 = list.find((m) => m.name === S);
      const t1 = list.find((m) => m.name === T);

      return s1?.repos === 1 && s1.open_branches === 2 && t1?.repos === 1 && t1.open_branches === 0 ? { s1, t1 } : null;
    }, 15_000);

    check("summary: repos and open_branches per monorepo (S: 1 project, 2 open branches; T: 1, 0)", !!line);
  }

  r = await call("GET", "/v1/monorepos", A);
  check("GET /v1/monorepos without summary is unchanged", r.json?.monorepos?.length === 5 && !("needs" in r.json.monorepos[0]));
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  for (const s of sockets) {
    try {
      s.ws.close();
    } catch {}
  }

  for (const m of made) {
    const r = await call("DELETE", `/v1/monorepos/${login.ana}/${m}?confirm=${login.ana}/${m}`, A);
    check(`delete ${m}`, r.status === 204, `${r.status}`);
  }

  if (made.length) {
    const d = await waitFor(async () => {
      const x = await debugFeed(login.ana);

      return x && !x.index.length && !Object.keys(x.pointers).length ? x : null;
    }, 30_000);

    check("deleting the monorepos empties ana's feed (leave messages)", !!d);
  }

  if (DEV_LOG) {
    // Alarms and drains of deleted monorepos run after the deletes: give them a summary tick (10 s on a plain server).
    await sleep(12_000);
    const lines = logLines().slice(logStart).map((l) => stripVTControlCharacters(l));
    // Fails the run: an undisposed RPC result; a 500 (the Worker logs "internal error: <message>"); Pando's own
    // error lines ("feed: ...") and uncaught exceptions; SQLITE_BUSY or SQLITE_READONLY (another dev server sharing
    // this one's state). Not: this test's own crash and failed drains.
    // Counted, not failed: workerd's bare "internal error; reference" lines. With shared state they come with the
    // SQLite errors above; on a server with its own state they still appear amid Artifacts traffic through wrangler
    // dev's remote-bindings proxy, with no JavaScript exception near them in a debug log and no check failing.
    // pando-dev, which has no proxy, has logged none; its logs are read after each deploy.
    const bad = [];
    let ours = 0;
    let internal = 0;

    for (const l of lines) {
      if (/feed test: (the object dies|a failed drain)/.test(l)) ours++;
      else if (l.startsWith("✘ [ERROR] Error: internal error; reference = ")) internal++;
      else if (/not disposed properly|SQLITE_(BUSY|READONLY)|✘ \[ERROR\] (Uncaught|internal error: |feed: )/.test(l)) bad.push(l);
    }

    const shared = bad.some((l) => /SQLITE_(BUSY|READONLY)/.test(l));
    check("the dev server logged no undisposed RPC results, 500s, Pando errors or SQLite lock errors during the run", bad.length === 0,
      `${bad.length}: ${bad.slice(0, 2).join(" | ").slice(0, 200)}${shared ? " (does another wrangler dev share this server's state? give each its own --persist-to)" : ""}`);
    console.log(`INFO  ${internal} workerd "internal error; reference" lines (counted, not failed); ${ours} from this test's own crash and failed drains`);
  } else console.log("SKIP  the dev server log check (set PANDO_DEV_LOG to the dev server's output)");
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
