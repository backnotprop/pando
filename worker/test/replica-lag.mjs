// How long a revoked credential still works because a D1 read replica has
// not caught up (C8). Run against a deployment with read replication on:
//
//   PANDO_URL=https://pando-dev.<subdomain>.workers.dev USE_HOME_CRED=1 node test/replica-lag.mjs
//
// Each trial makes a credential and never uses it before revoking it, so no
// isolate has it cached. It waits SETTLE_MS for the new credential to reach
// the replicas, revokes it, waits d ms, then uses it once. A 200 means the
// replica that answered had not seen the revoke yet. DELAYS and TRIALS set
// the grid. Credentials stay in memory and are never printed; each one is
// revoked by the trial itself.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const URL_ = (process.env.PANDO_URL ?? "").replace(/\/$/, "");
if (!URL_ || !process.env.USE_HOME_CRED) {
  console.error("needs PANDO_URL and USE_HOME_CRED=1");
  process.exit(2);
}
const S = readFileSync(join(homedir(), ".pando/credentials", new URL(URL_).host), "utf8").trim();
const DELAYS = (process.env.DELAYS ?? "0,250,1000").split(",").map(Number);
const TRIALS = Number(process.env.TRIALS ?? 5);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 20_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, secret, body) => {
  const res = await fetch(URL_ + path, {
    method,
    headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null), ray: res.headers.get("cf-ray") };
};

const results = [];
for (const d of DELAYS) {
  // Trials at one delay run side by side; each waits SETTLE_MS on its own.
  const trials = await Promise.all(
    Array.from({ length: TRIALS }, async (_, i) => {
      await sleep(i * 300);
      const made = await call("POST", "/v1/user/credentials", S, { name: `replica-lag-${Date.now().toString(36)}-${i}` });
      if (made.status !== 201) return { error: `create ${made.status}` };
      const x = made.json.secret;
      await sleep(SETTLE_MS);
      const t = Date.now();
      const del = await call("DELETE", `/v1/user/credentials/${made.json.id}`, S);
      if (del.status !== 204) return { error: `revoke ${del.status}` };
      await sleep(Math.max(0, d - (Date.now() - t)));
      const r = await call("GET", "/v1/user", x);
      return { still_works: r.status === 200, status: r.status, colo: r.ray?.split("-")[1] ?? "?" };
    }),
  );
  const ok = trials.filter((x) => !x.error);
  const works = ok.filter((x) => x.still_works).length;
  results.push({ d, works, of: ok.length, errors: trials.filter((x) => x.error).map((x) => x.error), colos: [...new Set(ok.map((x) => x.colo))] });
  console.log(`revoked ${d} ms ago: still worked ${works} of ${ok.length} (colo ${[...new Set(ok.map((x) => x.colo))].join(", ")})${trials.some((x) => x.error) ? "  errors: " + trials.filter((x) => x.error).map((x) => x.error).join(", ") : ""}`);
}
console.log(JSON.stringify(results));
