// Hook deliveries on the pando-hooks queue (C9), end to end against `wrangler dev`.
//
//   PANDO_URL=http://localhost:8797 node test/hooks.mjs
//
// worker/.dev.vars sets HOOK_RETRY_DELAYS=1,1,1,1 so retries take seconds,
// not 36 minutes. A receiver on this machine fails twice then succeeds (flaky),
// always fails (dead), or plays Buildkite. Checks: signatures, seq, attempts
// recorded, the dead-letter path, one row per (hook, event, seq) under
// redeliver, and replay from a seq. Credentials are never printed.
import { spawnSync } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");
const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
const SECRET = "hooks-test-secret";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`.replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<token>"));
};
const call = async (method, path, secret, body) => {
  const res = await fetch(URL_ + path, { method, headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const waitFor = async (pred, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};

// ── the receiver ──
const got = { flaky: [], dead: [], ok: [], buildkite: [] };
const tries = new Map();
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const route = req.url.slice(1);
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {}
    if (route === "buildkite") {
      got.buildkite.push(body);
      return res.writeHead(201).end("{}");
    }
    const want = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
    const sig = String(req.headers["x-pando-signature-256"] ?? "");
    const valid = sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
    const entry = { valid, delivery: req.headers["x-pando-delivery"], event: req.headers["x-pando-event"], body };
    (got[route] ?? []).push(entry);
    if (route === "dead") return res.writeHead(500).end("down");
    if (route === "flaky") {
      const n = (tries.get(entry.delivery) ?? 0) + 1;
      tries.set(entry.delivery, n);
      return res.writeHead(n <= 2 ? 503 : 200).end();
    }
    res.writeHead(200).end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const id = Date.now().toString(36);
const work = mkdtempSync(join(tmpdir(), "pando-hooks-"));
const M = `hk-${id}`;
let S = null;
let made = false;
try {
  S = (await call("POST", "/v1/users", BOOT, { login: `hk-${id}` })).json?.credential?.secret;
  let r = await call("POST", "/v1/monorepos", S, { name: M, kind: "repo" });
  made = r.status === 201;
  const url = r.json?.repos?.[0]?.clone_url;
  const base = `/v1/monorepos/${M}/repos/${M}`;
  const hook = async (body) => (await call("POST", `${base}/hooks`, S, body)).json?.id;
  const flaky = await hook({ type: "web", url: `http://127.0.0.1:${port}/flaky`, secret: SECRET, events: ["push", "merged"] });
  const dead = await hook({ type: "web", url: `http://127.0.0.1:${port}/dead`, secret: SECRET, events: ["push"] });
  const bk = await hook({ type: "buildkite", buildkite: { organization: "o", pipeline: "p", api_url: `http://127.0.0.1:${port}/buildkite` } });
  check("three hooks registered (web flaky, web dead, buildkite)", flaky && dead && bk);

  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" };
  const git = (a, cwd) => spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...a], { cwd, env, encoding: "utf8" });
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "f"), "x\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  git(["push", "-q", url, "main"], src);
  git(["checkout", "-qb", "feat"], src);
  writeFileSync(join(src, "g"), "y\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "feat"], src);
  const t0 = Date.now();
  check("push a branch", git(["push", "-q", url, "feat"], src).status === 0);
  const head = git(["rev-parse", "HEAD"], src).stdout.trim();
  const events = (await call("GET", `/v1/monorepos/${M}/events?since=0&limit=100`, S)).json?.events ?? [];
  const pushSeq = events.find((e) => e.collection === "branches" && e.row?.name === "feat")?.seq;

  // flaky: 503, 503, 200
  const deliveredFlaky = await waitFor(async () => {
    const ds = (await call("GET", `${base}/hooks/${flaky}/deliveries`, S)).json?.deliveries ?? [];
    const d = ds.find((x) => x.event === "push" && x.seq === pushSeq);
    return d?.status === "delivered" ? d : null;
  }, 60_000);
  const flakyGot = got.flaky.filter((x) => x.body?.head === head && x.event === "push");
  check("the flaky receiver fails twice, then the third try is delivered", !!deliveredFlaky && deliveredFlaky.attempts === 3 && flakyGot.length === 3, `${flakyGot.length} POSTs, ${deliveredFlaky?.attempts} attempts in ${Date.now() - t0} ms`);
  check("every try is the same delivery, signed, with the event's seq", new Set(flakyGot.map((x) => x.delivery)).size === 1 && flakyGot.every((x) => x.valid && x.body.seq === pushSeq), `seq ${pushSeq}`);
  check("the attempts are recorded (503, 503, 200)", JSON.stringify(deliveredFlaky?.recent_attempts?.map((a) => a.response_code)) === "[200,503,503]", JSON.stringify(deliveredFlaky?.recent_attempts?.map((a) => a.response_code)));
  check("the payload carries clone_url, a read token and the merge base", /^art_v\d+_/.test(flakyGot.at(-1)?.body?.read_token ?? "") && /^[0-9a-f]{40}$/.test(flakyGot.at(-1)?.body?.base ?? ""));

  // dead: 5 tries, then the dead-letter queue
  const deadD = await waitFor(async () => {
    const ds = (await call("GET", `${base}/hooks/${dead}/deliveries`, S)).json?.deliveries ?? [];
    const d = ds.find((x) => x.seq === pushSeq);
    return d?.status === "dead" ? d : null;
  }, 90_000);
  check("a dead receiver: 5 tries, then the dead-letter queue (status dead)", !!deadD && deadD.attempts === 5 && got.dead.filter((x) => x.body?.head === head).length === 5, `${deadD?.status}, ${deadD?.attempts} attempts, last ${deadD?.response_code}`);
  check("buildkite rides the same queue, with PANDO_SEQ", got.buildkite.some((b) => b?.commit === head && b?.env?.PANDO_SEQ === String(pushSeq)));

  // redeliver: same row, same seq, a new attempt
  const before = (await call("GET", `${base}/hooks/${flaky}/deliveries`, S)).json?.deliveries?.length;
  r = await call("POST", `${base}/hooks/deliveries/${deliveredFlaky.id}/redeliver`, S);
  check("redeliver sends the same delivery again (same id)", r.status === 202 && r.json?.id === deliveredFlaky.id);
  const again = await waitFor(() => got.flaky.filter((x) => x.delivery === deliveredFlaky.id).length >= 4 && got.flaky.filter((x) => x.delivery === deliveredFlaky.id).length, 30_000);
  const after = (await call("GET", `${base}/hooks/${flaky}/deliveries`, S)).json?.deliveries ?? [];
  check("no second row for (hook, event, seq)", again >= 4 && after.length === before && after.find((d) => d.id === deliveredFlaky.id)?.status === "delivered", `${after.length} rows`);

  // a merge, then replay from a seq
  r = await call("POST", `${base}/branches/feat/merge?force=1`, S);
  check("merge", r.status === 200);
  const merged = await waitFor(() => got.flaky.find((x) => x.event === "merged" && x.body?.merge_commit === r.json?.sha && tries.get(x.delivery) === 3));
  check("the merged event is delivered (after its two failures)", !!merged && typeof merged.body.seq === "number");
  const n0 = got.flaky.length;
  r = await call("POST", `${base}/hooks/${flaky}/redeliver?since=0`, S);
  check("replay from seq 0 queues every delivery of the hook (main's first push, the branch push, the merge)", r.status === 202 && r.json?.queued === 3, JSON.stringify(r.json?.queued));
  const replayed = await waitFor(() => got.flaky.length >= n0 + 3 && got.flaky.slice(n0));
  check("the replayed deliveries arrive, in their seqs", replayed && replayed.every((x) => x.valid && typeof x.body.seq === "number"), replayed ? replayed.map((x) => x.body.seq).join(",") : "none");
  r = await call("POST", `${base}/hooks/${flaky}/redeliver?since=${merged.body.seq}`, S);
  check("replay from the newest seq queues nothing", r.status === 202 && r.json?.queued === 0);
} catch (err) {
  check("no exception", false, String(err?.stack ?? err));
} finally {
  if (made) {
    const r = await call("DELETE", `/v1/monorepos/${M}?confirm=${M}`, S);
    check(`delete ${M}`, r.status === 204);
  }
  server.close();
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
