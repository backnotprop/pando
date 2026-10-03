// A home load for one person with N monorepos (C25): the three calls the home
// makes (the first activity page, the monorepo list with summaries, needs-you),
// one at a time and together; a second page; a page past the feed's window;
// and how long an event takes to reach the person's live socket.
//
//   PANDO_URL=http://localhost:8811 N=10 node test/feed-load.mjs     (wrangler dev with FEED_TEST=1)
//   PANDO_URL=https://pando-dev... USE_HOME_CRED=1 FEED_TEST_ROUTE=0 N=10 node test/feed-load.mjs
//     (as the signed-in person of ~/.pando/credentials/<host>; their other monorepos count too)
//
// Each monorepo is a plain repo with 3 worktree reports and a status; NEEDS of
// them also get a pushed branch (ready; one failing). Credentials stay in
// memory; git never reaches the keychain; it deletes every monorepo it made.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch } from "./errors.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8811").replace(/\/$/, "");
const WS_ = URL_.replace(/^http/, "ws");
const N = Number(process.env.N ?? 10);
const NEEDS = Math.min(N, Number(process.env.NEEDS ?? 5));
const RUNS = Number(process.env.RUNS ?? 20);
const LIVE = Number(process.env.LIVE ?? 20);
const HOME_CRED = !!process.env.USE_HOME_CRED;
const BOOT = HOME_CRED ? null : (process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1]);
const TEST_ROUTE = process.env.FEED_TEST_ROUTE !== "0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// wrangler dev reloads now and then (its remote-binding session), resetting connections: retry once.
const call = async (method, path, secret, body, retry = true) => {
  try {
    return await call1(method, path, secret, body);
  } catch (err) {
    if (!retry) throw err;
    await sleep(3000);
    return call(method, path, secret, body, false);
  }
};
const call1 = async (method, path, secret, body) => {
  const t = performance.now();
  const res = await fetch(URL_ + path, { method, headers: { authorization: `Bearer ${secret}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, ms: performance.now() - t, bytes: text.length };
};
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}
const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (xs) => `p50 ${q(xs, 50).toFixed(0)} ms, p95 ${q(xs, 95).toFixed(0)} ms, max ${Math.max(...xs).toFixed(0)} ms (n=${xs.length})`;
const work = mkdtempSync(join(tmpdir(), "pando-feedload-"));
const id = Date.now().toString(36);
const made = [];
let S;
const out = [];
const say = (s) => {
  out.push(s);
  console.log(s);
};
let me = null; // the owner of everything made here (namespaces: owner/name)
try {
  S = HOME_CRED
    ? readFileSync(join(homedir(), ".pando/credentials", new URL(URL_).host), "utf8").trim()
    : (await call("POST", "/v1/users", BOOT, { login: `feedload-${id}`, credential_name: "feedload-mbp" })).json?.credential?.secret;
  me = (await call("GET", "/v1/user", S)).json?.login;
  const names = Array.from({ length: N }, (_, i) => `hl${i}-${id}`);
  const clone = {};
  let t0 = performance.now();
  await pool(names, 5, async (m) => {
    const r = await call("POST", "/v1/monorepos", S, { name: m, kind: "repo" });
    if (r.status === 201) {
      made.push(m);
      clone[m] = r.json.repos[0].clone_url;
    } else console.log(`create ${m}: ${r.status} ${r.json?.error?.code}`);
  });
  say(`made ${made.length} monorepos in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  // Activity: 3 worktree reports and a status in each.
  await pool(made, 10, async (m) => {
    for (let k = 0; k < 3; k++) await call("PUT", `/v1/monorepos/${me}/${m}/worktrees/wt${k}`, S, { repo: ".", branch: `b${k}`, path: `worktrees/b${k}`, machine: "hl-mbp", kind: "sparse" });
    await call("POST", `/v1/monorepos/${me}/${m}/repos/${m}/statuses/${"a".repeat(40)}`, S, { state: "success", context: "ci" });
  });
  // Needs: a real branch in NEEDS monorepos (ready); the first one failing.
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" };
  const git = (a, cwd) => spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...a], { cwd, env, encoding: "utf8" });
  for (const m of made.slice(0, NEEDS)) {
    const src = join(work, m);
    mkdirSync(src);
    git(["init", "-q"], src);
    writeFileSync(join(src, "README.md"), "# x\n");
    git(["add", "-A"], src);
    git(["commit", "-qm", "first"], src);
    git(["push", "-q", clone[m], "main"], src);
    git(["checkout", "-qb", "feat"], src);
    writeFileSync(join(src, "f.txt"), "f\n");
    git(["add", "-A"], src);
    git(["commit", "-qm", "feat"], src);
    git(["push", "-q", clone[m], "feat"], src);
    if (m === made[0]) {
      const head = git(["rev-parse", "HEAD"], src).stdout.trim();
      await call("POST", `/v1/monorepos/${me}/${m}/repos/${m}/statuses/${head}`, S, { state: "failure", context: "ci" });
    }
  }
  // Settle: every monorepo joined, needs counted.
  t0 = performance.now();
  let settled = false;
  for (let i = 0; i < 120 && !settled; i++) {
    const r = await call("GET", "/v1/monorepos?summary=1", S);
    const ms = r.json?.monorepos ?? [];
    const needs = ms.reduce((a, m) => a + (m.needs ? m.needs.ready + m.needs.failing : 0), 0);
    const mine = ms.filter((m) => made.includes(m.name));
    settled = mine.length === made.length && mine.every((m) => m.last_activity_at) && needs >= NEEDS;
    if (!settled) await sleep(1000);
  }
  say(`settled (joins, summaries, needs) in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${settled}`);

  // ── The home's calls ──
  const lat = { events: [], summary: [], needs: [], home: [], page2: [] };
  let sizes = {};
  for (let i = 0; i < RUNS; i++) {
    const a = await call("GET", "/v1/events?limit=50", S);
    const b = await call("GET", "/v1/monorepos?summary=1", S);
    const c = await call("GET", "/v1/branches?state=open&needs=ready,conflicts,failing", S);
    lat.events.push(a.ms);
    lat.summary.push(b.ms);
    lat.needs.push(c.ms);
    sizes = { events: a.json?.events?.length, events_bytes: a.bytes, monorepos: b.json?.monorepos?.length, summary_bytes: b.bytes, needs: c.json?.branches?.length, needs_bytes: c.bytes, from_logs: a.json?.from_logs, skipped: a.json?.skipped?.length };
    const p2 = await call("GET", `/v1/events?limit=50&cursor=${a.json?.next}`, S);
    if (a.json?.next) lat.page2.push(p2.ms);
    const t = performance.now();
    await Promise.all([call("GET", "/v1/events?limit=50", S), call("GET", "/v1/monorepos?summary=1", S), call("GET", "/v1/branches?state=open&needs=ready,conflicts,failing", S)]);
    lat.home.push(performance.now() - t);
  }
  say(`N=${N}: ${JSON.stringify(sizes)}`);
  say(`  GET /v1/events?limit=50            ${fmt(lat.events)}`);
  if (lat.page2.length) say(`  second page (cursor)              ${fmt(lat.page2)}`);
  say(`  GET /v1/monorepos?summary=1        ${fmt(lat.summary)}`);
  say(`  GET /v1/branches?needs=...         ${fmt(lat.needs)}`);
  say(`  home load (the three at once)      ${fmt(lat.home)}`);

  // ── Event to the live socket ──
  const ws = new WebSocket(`${WS_}/v1/events`, { headers: { authorization: `Bearer ${S}` } });
  const arrivals = new Map();
  ws.onmessage = (e) => {
    try {
      const f = JSON.parse(e.data);
      if (f.type === "event" && f.event.kind === "worktree.reported") arrivals.set(f.event.summary.worktree, performance.now());
    } catch {}
  };
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ type: "hello" }));
  const sent = new Map();
  for (let k = 0; k < LIVE; k++) {
    const m = made[k % made.length];
    const wid = `live${k}`;
    const t = performance.now();
    await call("PUT", `/v1/monorepos/${me}/${m}/worktrees/${wid}`, S, { repo: ".", branch: `l${k}`, path: `worktrees/l${k}`, machine: "hl-mbp", kind: "sparse" });
    sent.set(wid, t);
    await sleep(300);
  }
  await sleep(3000);
  const d = [...sent].filter(([w]) => arrivals.has(w)).map(([w, t]) => arrivals.get(w) - t);
  say(`  event to the live socket (worktree report sent to frame received, ${d.length}/${LIVE})  ${d.length ? fmt(d) : "none"}`);
  // A push goes through the branch-facts job first (commit count, head title), then the feed.
  const pushArrivals = new Map();
  ws.onmessage = (e) => {
    try {
      const f = JSON.parse(e.data);
      if (f.type === "event" && f.event.kind === "branch.opened") pushArrivals.set(`${f.event.monorepo?.split("/")[1]}/${f.event.branch}`, performance.now());
    } catch {}
  };
  const pushSent = new Map();
  for (let k = 0; k < Math.min(NEEDS, 5); k++) {
    const m = made[k];
    const src = join(work, m);
    git(["checkout", "-q", "main"], src);
    git(["checkout", "-qb", `p${k}`], src);
    writeFileSync(join(src, `p${k}.txt`), "p\n");
    git(["add", "-A"], src);
    git(["commit", "-qm", `p${k}`], src);
    const t = performance.now();
    git(["push", "-q", clone[m], `p${k}`], src);
    pushSent.set(`${m}/p${k}`, { t, git: performance.now() - t });
    await sleep(4000); // git runs synchronously here: wait for the frame before the next push blocks the loop
  }
  const pd = [...pushSent].filter(([k]) => pushArrivals.has(k)).map(([k, v]) => pushArrivals.get(k) - v.t - v.git);
  say(`  a push to the live socket (git push returned to frame received, ${pd.length}/${pushSent.size})  ${pd.length ? fmt(pd) : "none"}`);
  ws.close();

  // ── Past the window: trim the feed to nothing; pages read the monorepos' logs ──
  if (TEST_ROUTE) {
    await call("POST", "/v1/_feed/test", BOOT, { trim: { login: me, days: 0 } });
    const past = [];
    let info = null;
    for (let i = 0; i < RUNS; i++) {
      const r = await call("GET", "/v1/events?limit=50", S);
      past.push(r.ms);
      info = { events: r.json?.events?.length, from_logs: r.json?.from_logs, skipped: r.json?.skipped?.length };
    }
    say(`  past the window (every line from logs): ${JSON.stringify(info)}  ${fmt(past)}`);
  }
} catch (err) {
  console.log("exception:", describeError(err));
} finally {
  const t0 = performance.now();
  await pool(made, 5, async (m) => {
    const r = await call("DELETE", `/v1/monorepos/${me}/${m}?confirm=${me}/${m}`, S);
    if (r.status !== 204) console.log(`delete ${m}: ${r.status}`);
  });
  console.log(`deleted ${made.length} monorepos in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  // Deleting a monorepo clears it from the person's home and log (leave messages).
  if (made.length && S) {
    const gone = new Set(made.map((m) => `${me}/${m}`));
    let left = null;
    for (let i = 0; i < 30; i++) {
      const ev = (await call("GET", "/v1/events?limit=200", S)).json?.events ?? [];
      const ms = (await call("GET", "/v1/monorepos?summary=1", S)).json?.monorepos ?? [];
      left = { lines: ev.filter((e) => gone.has(e.monorepo)).length, monorepos: ms.filter((m) => gone.has(m.full_name)).length };
      if (!left.lines && !left.monorepos) break;
      await sleep(1000);
    }
    console.log(`after delete, left on the home: ${JSON.stringify(left)}`);
  }
  rmSync(work, { recursive: true, force: true });
}
