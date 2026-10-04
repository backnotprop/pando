// What a monorepo's summary line costs its members' feeds (C25; feed/out.ts,
// feed/routes.ts), end to end against wrangler dev. A small monorepo sends
// its line to every member's feed when it changes. A large one (over the
// split) sends it only when it crosses the split; the home reads its line
// when it loads, as it reads its events. Before (until 2026-10-04) a large
// one sent it too, once a minute when it changed: 200 active repositories of
// a 2,000-person org were about 6,667 feed writes a second.
//
// Every member keeps their live socket open, where each summary their feed
// takes arrives as one `summary` frame: the frames counted are the writes.
// The same activity runs in a large monorepo (6 members) and a small one
// (2). With the split at 2 and a 0.5 s tick, as feed.mjs:
//
//   npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to <dir>
//   npx wrangler dev --port 8837 --persist-to <dir> --var FEED_FANOUT_MAX:2 --var FEED_TICK_MS:500 --var FEED_TEST:1
//   PANDO_URL=http://localhost:8837 node test/summary-writes.mjs
//
// It prints the counts. Credentials are never printed. It deletes every
// monorepo it made.
import { readFileSync } from "node:fs";
import { describeError, retryResetFetch } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8837").replace(/\/$/, "");

const WS_ = URL_.replace(/^http/, "ws");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>");

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = (method, path, secret, body) => request(URL_, method, path, { secret, body });

async function waitFor(pred, ms = 30_000, every = 200) {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await pred();

    if (v) return v;
    await sleep(every);
  }

  return null;
}

/** The person's live socket (GET /v1/events with Upgrade), collecting JSON frames. */
function personSocket(secret) {
  const s = { frames: [], open: false };
  s.ws = new WebSocket(`${WS_}/v1/events`, { headers: { authorization: `Bearer ${secret}` } });
  s.ws.onopen = () => {
    s.open = true;
    s.ws.send(JSON.stringify({ type: "hello" }));
  };

  s.ws.onmessage = (e) => {
    try {
      s.frames.push(JSON.parse(e.data));
    } catch {
      // pong
    }
  };

  return s;
}

const id = Date.now().toString(36);

const logins = [0, 1, 2, 3, 4, 5].map((i) => `sw${i}-${id}`);

const [L, S] = [`swl-${id}`, `sws-${id}`];

const ID = {};

const made = [];

const sockets = [];

const debugFeed = async (login) => (await call("GET", `/v1/_feed/test?login=${login}`, BOOT)).json;

const largeIn = async (login, m) => (await debugFeed(login))?.index?.find((r) => r.name === ID[m])?.large;

let secrets = [];

try {
  secrets = await Promise.all(logins.map(async (login) => (await call("POST", "/v1/users", BOOT, { login, credential_name: `${login}-box` })).json?.credential?.secret));
  check("six people", secrets.every(Boolean));
  const [P0, , , P3] = secrets;

  for (const m of [L, S]) {
    const r = await call("POST", "/v1/monorepos", P0, { name: m, kind: "repo" });

    if (r.status === 201) made.push(m);
    ID[m] = r.json?.monorepo?.id;
  }

  check("two plain repos made", made.length === 2);
  const t = await call("GET", "/v1/_feed/test?login=x", BOOT);

  if (t.status === 404) throw new Error("start wrangler dev with --var FEED_TEST:1 (and FEED_FANOUT_MAX:2, FEED_TICK_MS:500)");

  for (const login of logins.slice(1)) await call("PUT", `/v1/monorepos/${logins[0]}/${L}/members/${login}`, P0, { role: "member" });
  await call("PUT", `/v1/monorepos/${logins[0]}/${S}/members/${logins[1]}`, P0, { role: "member" });

  const joined = await waitFor(async () => {
    for (const login of logins) if ((await largeIn(login, L)) !== true) return null;

    return (await largeIn(logins[0], S)) === false && (await largeIn(logins[1], S)) === false;
  });

  check("the split (2): L's 6 members' feeds hold it as large, S's 2 as small", !!joined);

  for (const secret of secrets) sockets.push(personSocket(secret));
  check("every member's live socket is open", !!(await waitFor(() => sockets.every((s) => s.frames.some((f) => f.type === "caught_up")), 10_000)));
  // Joins and the crossing settle first (a few ticks).
  await sleep(2000);
  const from = sockets.map((s) => s.frames.length);
  const newFrames = () => sockets.flatMap((s, i) => s.frames.slice(from[i]));

  // ── The same activity in both: a new worktree reported every 0.5 s for 10 s ──
  const LINES = 20;
  const t0 = Date.now();

  for (let i = 0; i < LINES; i++) {
    for (const m of [L, S]) {
      await call("PUT", `/v1/monorepos/${logins[0]}/${m}/worktrees/wt_${i}_${id}`, P0, { repo: ".", branch: `feat/w${i}`, path: `worktrees/w${i}`, machine: "sw-box", kind: "sparse" });
    }

    await sleep(Math.max(0, t0 + (i + 1) * 500 - Date.now()));
  }

  await sleep(2000);
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  const frames = newFrames();
  const of = (m, type) => frames.filter((f) => f.type === type && f.monorepo_id === ID[m]).length;
  const writes = { L: of(L, "summary"), Lneeds: of(L, "needs"), S: of(S, "summary") };

  console.log(`INFO  ${LINES} lines each in ${seconds} s, tick 0.5 s: large L (6 members) took ${writes.L} summary writes (${writes.Lneeds} needs frames); small S (2 members) took ${writes.S}`);
  check("a small monorepo still sends its line to its members' feeds as it changes", writes.S >= 4, `${writes.S} writes`);
  check("a large monorepo sends no summary line to its members' feeds while it stays large", writes.L === 0 && writes.Lneeds === 0, `${writes.L} summary, ${writes.Lneeds} needs`);

  // ── The home reads a large monorepo's line when it loads ──
  const newest = (await call("GET", `/v1/events?in=${logins[0]}/${L}&limit=1`, P3)).json?.events?.[0];
  let line = (await call("GET", "/v1/monorepos?summary=1", P3)).json?.monorepos?.find((m) => m.id === ID[L]);
  check("the home's list reads L's line from L: its last activity is L's newest line, with 6 members", !!newest && line?.last_activity_at === newest.at && line.members === 6 && line.large === true, `${line?.last_activity_at} vs ${newest?.at}; ${line?.members} members`);
  const kept = (await debugFeed(logins[3]))?.index?.find((r) => r.name === ID[L])?.summary;
  check("... not from the feed's copy, which stays as it was when L crossed the split", !!kept && kept.last_activity_at !== newest?.at, `${kept?.last_activity_at}`);
  const issue = await call("POST", `/v1/monorepos/${logins[0]}/${L}/issues`, P0, { title: "Large repo issue", assignees: [logins[3]] });
  const needs = (await call("GET", "/v1/branches", P3)).json;
  const mine = needs?.issues?.find((x) => x.monorepo_id === ID[L]);
  check("Needs you reads L's line at once: the issue just assigned is there", issue.status === 201 && mine?.newest?.title === "Large repo issue", JSON.stringify(mine ?? needs?.issues ?? needs).slice(0, 200));
  line = (await call("GET", "/v1/monorepos?summary=1", P3)).json?.monorepos?.find((m) => m.id === ID[L]);
  check("... and so does the list (assigned)", line?.assigned?.[logins[3]]?.count === 1, JSON.stringify(line?.assigned));

  // ── Crossing the split still tells members' feeds, both ways ──
  for (const login of logins.slice(2)) await call("DELETE", `/v1/monorepos/${logins[0]}/${L}/members/${login}`, P0);
  const small = await waitFor(async () => (await largeIn(logins[0], L)) === false && (await largeIn(logins[1], L)) === false, 15_000);
  check("down to 2 members: its members' feeds hear it is small again", !!small);

  for (const login of logins.slice(2)) await call("PUT", `/v1/monorepos/${logins[0]}/${L}/members/${login}`, P0, { role: "member" });

  const large = await waitFor(async () => {
    for (const login of logins) if ((await largeIn(login, L)) !== true) return null;

    return true;
  }, 15_000);

  check("back to 6: every member's feed holds it as large again", !!large);

  // ── Past 20 large monorepos (LOGS_MAX), the home's log reads the 20 most recently active, by their lines now ──
  const many = Array.from({ length: 21 }, (_, i) => `swg${i}-${id}`);

  for (const m of many) {
    const r = await call("POST", "/v1/monorepos", P0, { name: m, kind: "repo" });

    if (r.status === 201) made.push(m);
    ID[m] = r.json?.monorepo?.id;

    for (const login of logins.slice(1, 3)) await call("PUT", `/v1/monorepos/${logins[0]}/${m}/members/${login}`, P0, { role: "member" });
  }

  const allLarge = await waitFor(async () => {
    const index = (await debugFeed(logins[0]))?.index ?? [];

    return many.every((m) => index.some((r) => r.name === ID[m] && r.large && r.summary));
  }, 60_000);

  check("21 more large monorepos (22 with L), each held as large", !!allLarge);

  // L's activity is older than all of theirs, then swg0's: those two are past the 20.
  for (const m of many) await call("PUT", `/v1/monorepos/${logins[0]}/${m}/worktrees/wt_g_${id}`, P0, { repo: ".", branch: "feat/g", path: "worktrees/g", machine: "sw-box", kind: "sparse" });

  const page = (await call("GET", "/v1/events?limit=50", P0)).json;
  const skipped = [...(page?.skipped ?? [])].sort();
  check("past 20, the log reads the 20 most recently active (by their lines now) and names the other two", JSON.stringify(skipped) === JSON.stringify([`${logins[0]}/${L}`, `${logins[0]}/${many[0]}`].sort()) && page.events.some((e) => e.monorepo_id === ID[many[20]]), JSON.stringify(skipped));
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  for (const s of sockets) {
    try {
      s.ws.close();
    } catch {}
  }

  for (const m of made) {
    const r = await call("DELETE", `/v1/monorepos/${logins[0]}/${m}?confirm=${logins[0]}/${m}`, secrets[0]);
    check(`delete ${m}`, r.status === 204, `${r.status}`);
  }

  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
