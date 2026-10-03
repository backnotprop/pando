// The Machines tab (RESEARCH section 7), timed: with M machines (credentials)
// in one monorepo, how long a connect and a disconnect take to reach a
// watcher as machine.updated, how long an activity takes to show on the row,
// and GET .../machines.
//
//   PANDO_URL=http://localhost:8811 node test/machines-load.mjs              (wrangler dev; a throwaway user)
//   PANDO_URL=https://pando-dev... USE_HOME_CRED=1 node test/machines-load.mjs
//     (as the signed-in person; it makes M credentials named machines-load-*
//      and revokes them, and one monorepo it deletes)
//
// Credentials stay in memory and are never printed.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8811").replace(/\/$/, "");

const WS_ = URL_.replace(/^http/, "ws");

const M = Number(process.env.M ?? 10);

const N = Number(process.env.N ?? 20);

const HOME_CRED = !!process.env.USE_HOME_CRED;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = async (method, path, secret, body) => {
  const t = performance.now();
  const res = await fetch(URL_ + path, { method, headers: { authorization: `Bearer ${secret}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;

  try {
    json = JSON.parse(text);
  } catch {}

  return { status: res.status, json, ms: performance.now() - t };
};

const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

const fmt = (xs) => (xs.length ? `p50 ${q(xs, 50).toFixed(0)} ms, p95 ${q(xs, 95).toFixed(0)} ms, max ${Math.max(...xs).toFixed(0)} ms (n=${xs.length})` : "none");

const open = (path, secret, onFrame) =>
  new Promise((resolve) => {
    const ws = new WebSocket(WS_ + path, { headers: { authorization: `Bearer ${secret}` } });
    ws.onmessage = (e) => {
      try {
        onFrame?.(JSON.parse(e.data), performance.now());
      } catch {}
    };

    ws.onopen = () => resolve(ws);
  });

const id = Date.now().toString(36);

let S;

let me;

let made = null;

const creds = [];

try {
  if (HOME_CRED) S = readFileSync(join(homedir(), ".pando/credentials", new URL(URL_).host), "utf8").trim();
  else {
    const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
    S = (await call("POST", "/v1/users", BOOT, { login: `ml-${id}`, credential_name: "ml-main" })).json?.credential?.secret;
  }

  me = (await call("GET", "/v1/user", S)).json?.login;
  const name = `ml-${id}`;
  const r = await call("POST", "/v1/monorepos", S, { name, kind: "repo" });

  if (r.status !== 201) throw new Error(`create: ${r.status}`);
  made = name;
  const base = `/v1/monorepos/${me}/${name}`;

  for (let k = 0; k < M; k++) {
    const c = (await call("POST", "/v1/user/credentials", S, { name: `machines-load-${id}-${k}`, kind: "machine" })).json;
    creds.push({ id: c.id, secret: c.secret, name: c.name });
  }

  // The watcher: machine.updated frames, by machine name and connected state.
  const seen = [];
  await open(`${base}/events?topics=kind:machine.updated`, S, (f, t) => {
    if (f.kind === "machine.updated") seen.push({ name: f.row?.name, connected: f.row?.connected, t });
  });

  const waitSeen = async (pred, ms = 10_000) => {
    const end = Date.now() + ms;

    while (Date.now() < end) {
      const x = seen.find(pred);

      if (x) return x;
      await sleep(20);
    }

    return null;
  };

  // Connect then disconnect each machine, one at a time, N rounds over the M machines.
  const connect = [];
  const disconnect = [];

  for (let k = 0; k < N; k++) {
    const c = creds[k % M];
    const ws = await open(`${base}/events?topics=main`, c.secret);
    const t0 = performance.now();
    ws.send(JSON.stringify({ type: "hello", machine: c.name, worktrees: [`w${k}`] }));
    const up = await waitSeen((s) => s.name === c.name && s.connected && s.t >= t0);

    if (up) connect.push(up.t - t0);

    if (k >= N - M) continue; // the last M stay connected for the list below
    const t1 = performance.now();
    ws.close();
    const down = await waitSeen((s) => s.name === c.name && s.connected === false && s.t >= t1);

    if (down) disconnect.push(down.t - t1);
  }

  console.log(`M=${M} machines in one monorepo`);
  console.log(`  hello to machine.updated (connected) on a watcher   ${fmt(connect)}`);
  console.log(`  close to machine.updated (disconnected)             ${fmt(disconnect)}`);
  // Activity: a worktree report through a machine's credential, until its row shows it.
  const act = [];

  for (let k = 0; k < N; k++) {
    const c = creds[k % M];
    const wid = `act${k}_${id}`;
    const t0 = performance.now();
    await call("PUT", `${base}/worktrees/${wid}`, c.secret, { repo: ".", branch: wid, path: `worktrees/${wid}`, machine: c.name, kind: "sparse" });

    for (let i = 0; i < 100; i++) {
      const rows = (await call("GET", `${base}/machines`, S)).json?.machines ?? [];

      if (rows.find((x) => x.name === c.name)?.last_activity?.summary?.worktree === wid) {
        act.push(performance.now() - t0);
        break;
      }
    }
  }

  console.log(`  worktree report to its row in GET .../machines       ${fmt(act)}`);
  const list = [];
  let rows = [];

  for (let k = 0; k < N; k++) {
    const g = await call("GET", `${base}/machines`, S);
    list.push(g.ms);
    rows = g.json?.machines ?? [];
  }

  console.log(`  GET .../machines (${rows.length} rows, ${rows.filter((x) => x.connected).length} connected)   ${fmt(list)}`);
} catch (err) {
  console.log("exception:", String(err?.message ?? err).replace(/pando_[a-f0-9]{20,}/g, "<credential>"));
} finally {
  if (made) {
    const r = await call("DELETE", `/v1/monorepos/${me}/${made}?confirm=${me}/${made}`, S);
    console.log(`delete ${made}: ${r.status}`);
  }

  let revoked = 0;

  for (const c of creds) if ((await call("DELETE", `/v1/user/credentials/${c.id}`, S)).status === 204) revoked++;
  console.log(`revoked ${revoked} of ${creds.length} credentials`);
  process.exit(0);
}
