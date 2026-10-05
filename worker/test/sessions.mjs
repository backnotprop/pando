// Agent sessions, end to end (stage 1: store and read): real wrangler dev, its local D1, Durable Objects and R2, and
// the real Artifacts service for the monorepo. Fixtures are sessions recorded for this test in scratch folders with
// placeholder prompts (test/sessions/fixtures): Pi 0.85.1 and OpenCode V2 2.0.22 (rows as `pando sync` reads them).
//
//   npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to <dir>
//   npx wrangler dev --port 8869 --inspector-port 9369 --persist-to <dir> --var FEED_TICK_MS:500
//   PANDO_URL=http://localhost:8869 node test/sessions.mjs
//
// Credentials stay in memory and are never printed. It deletes its monorepo.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describeError, retryResetFetch, throwaways } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8869").replace(/\/$/, "");

const WS_ = URL_.replace(/^http/, "ws");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`.replace(/pando_[a-f0-9]{20,}/g, "<credential>"));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = (method, path, secret, body, headers = {}) => request(URL_, method, path, { secret, body, headers });

const fixture = (name) => readFileSync(new URL(`./sessions/fixtures/${name}`, import.meta.url), "utf8");

/** The session id, as the Worker, the hook and `pando sync` derive it: s_ and SHA-256("<program>:<id>")'s first 128 bits in Crockford base32. */
function sessionId(program, agentId) {
  let n = BigInt(`0x${createHash("sha256").update(`${program}:${agentId}`).digest("hex").slice(0, 32)}`);
  let out = "";

  for (let i = 0; i < 26; i++) {
    out = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number(n & 31n)] + out;
    n >>= 5n;
  }

  return `s_${out}`;
}

/** Every recorded time in a line moved by `ms` (ISO strings and epoch milliseconds), so a fixture reads as recorded now. */
function shift(line, ms) {
  const keys = new Set(["timestamp", "time_created", "created", "completed", "streamed", "ran", "start", "end"]);

  return JSON.stringify(JSON.parse(line, (k, v) => {
    if (!keys.has(k)) return v;

    if (Number.isSafeInteger(v) && v > 1e11) return v + ms;

    return /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(Date.parse(v) + ms).toISOString() : v;
  }));
}

/** A fixture's lines moved so its last record is `agoMs` before now. */
function recent(text, agoMs) {
  const lines = text.split("\n").filter(Boolean);
  const times = lines.flatMap((l) => [...l.matchAll(/"(?:timestamp|time_created)":(?:"([^"]+)"|(\d{12,}))/g)].map((m) => (m[1] ? Date.parse(m[1]) : Number(m[2]))));
  const by = Date.now() - agoMs - Math.max(...times);

  return lines.map((l) => shift(l, by)).join("\n") + "\n";
}

// The contract's recordings of the session answers (packages/contract/recorded, checked by check-recorded.ts).
const RECORDED = new URL("../../packages/contract/recorded/", import.meta.url);

const record = (file, schema, route, status, body) => writeFileSync(new URL(file, RECORDED), `${JSON.stringify({ schema, route, status, body }, null, 2).replace(/pando_[a-f0-9]{20,}/g, "<credential>")}\n`);

const piece = (path, secret, start, at, next, lines, extra = {}) => {
  const gzip = extra.gzip ?? false;
  const headers = { "pando-session": JSON.stringify(start), "content-type": "application/x-ndjson" };

  if (gzip) headers["content-encoding"] = "gzip";

  return request(URL_, "POST", `${path}/pieces?at=${at}&next=${next}`, { secret, raw: gzip ? gzipSync(Buffer.from(lines)) : lines, headers });
};

function socket(path, secret) {
  const frames = [];
  const ws = new WebSocket(`${WS_}${path}`, { headers: { authorization: `Bearer ${secret}` } });
  ws.onmessage = (m) => {
    try {
      frames.push(JSON.parse(m.data));
    } catch {}
  };

  return { ws, frames };
}

const id = Date.now().toString(36);

const ana = `se-a-${id}`;

const bo = `se-b-${id}`;

const cy = `se-c-${id}`;

const M = `se-${id}`;

const mb = `/v1/monorepos/${ana}/${M}`;

let A = null;

const sockets = [];

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, A)).status);

try {
  A = (await call("POST", "/v1/users", BOOT, { login: ana, credential_name: "ana-mbp" })).json?.credential?.secret;
  const B = (await call("POST", "/v1/users", BOOT, { login: bo, credential_name: "bo-mbp" })).json?.credential?.secret;
  const Cy = (await call("POST", "/v1/users", BOOT, { login: cy })).json?.credential?.secret;
  let r = await call("POST", "/v1/monorepos", A, { name: M });

  if (r.status === 201) tw.add(`${ana}/${M}`);
  r = await call("PUT", `${mb}/members/${bo}`, A, { role: "member" });
  check("a repository with an owner (ana) and a member (bo)", r.status === 200, `${r.status}`);

  const live = socket(`${mb}/events?topics=sessions`, A);
  sockets.push(live.ws);
  await sleep(500);

  // ── Pi: two pieces, cut at a line ──
  const pi = recent(fixture("pi.jsonl"), 60_000);
  const piAgent = JSON.parse(pi.split("\n")[0]).id;
  const piId = sessionId("pi", piAgent);
  const piPath = `${mb}/sessions/${piId}`;
  const piStart = { program: "pi", agent_id: piAgent, repo: "projects-a", branch: "fix-login", parent: null };
  const cut = Buffer.byteLength(pi.split("\n").slice(0, 6).join("\n") + "\n");
  const first = Buffer.from(pi).subarray(0, cut).toString();
  const rest = Buffer.from(pi).subarray(cut).toString();

  r = await call("GET", piPath, A);
  check("a session not yet recorded is 404", r.status === 404, `${r.status}`);
  r = await piece(piPath, A, { ...piStart, agent_id: "someone-else" }, 0, cut, first);
  check("a piece whose id is not the agent's is refused (400 bad_session_id)", r.status === 400 && r.json?.error?.code === "bad_session_id", `${r.status}`);
  r = await piece(piPath, A, piStart, 0, cut, first);
  check("the first piece makes the session, at the end it names", r.status === 200 && r.json?.end === cut && r.json?.person === ana && r.json?.machine === "ana-mbp" && r.json?.program === "pi", `${r.status} ${r.json?.end}`);
  check("its first piece already counts one prompt and one tool call", r.json?.prompts === 1 && r.json?.tool_calls === 1, `${r.json?.prompts} ${r.json?.tool_calls}`);
  r = await piece(piPath, A, piStart, 0, cut, first);
  record("session-not-at-end.json", "ErrorBody", "POST .../sessions/{id}/pieces (not at the end: 409 with it)", r.status, r.json);
  check("the same piece again is refused with the end to resume from (409)", r.status === 409 && r.json?.error?.code === "not_at_end" && r.json?.error?.end === cut, `${r.status} ${JSON.stringify(r.json?.error ?? {}).slice(0, 120)}`);
  r = await piece(piPath, B, piStart, cut, Buffer.byteLength(pi), rest);
  check("another person cannot add to ana's session (403)", r.status === 403 && r.json?.error?.code === "not_your_session", `${r.status}`);
  r = await piece(piPath, Cy, piStart, cut, Buffer.byteLength(pi), rest);
  check("someone outside the repository cannot (403 not_a_member)", r.status === 403, `${r.status}`);
  r = await piece(piPath, A, piStart, cut, Buffer.byteLength(pi), rest, { gzip: true });
  const pi1 = r.json;
  record("session.json", "Session", "POST .../sessions/{id}/pieces?at=&next= (gzip)", r.status, r.json);
  check("the second piece, gzipped, lands at the end", r.status === 200 && pi1?.end === Buffer.byteLength(pi), `${r.status}`);
  check("two prompts, one tool call, one model with its answers", pi1?.prompts === 2 && pi1?.tool_calls === 1 && pi1?.models?.length === 1 && pi1?.models[0].answers === 3, JSON.stringify(pi1?.models));
  check("a record in the last 30 minutes: active", pi1?.state === "active" && pi1?.repo === "projects-a" && pi1?.branch === "fix-login", pi1?.state);

  r = await call("GET", `${piPath}/entries`, B);
  record("session-entries.json", "SessionEntries", "GET .../sessions/{id}/entries", r.status, r.json);
  const entries = r.json?.entries ?? [];
  const prompts = entries.filter((e) => e.kind === "prompt");
  const tool = entries.find((e) => e.kind === "tool");
  check("a member reads the conversation: prompts 1 and 2 in order", r.status === 200 && prompts.length === 2 && prompts[0].prompt === 1 && prompts[1].prompt === 2 && r.json?.next_cursor === null, `${r.status} ${prompts.map((p) => p.prompt)}`);
  check("the tool call keeps its name, input and result, paired", tool?.tool === "bash" && tool?.input?.includes("git commit") && tool?.result !== null && tool?.ok === true, `${tool?.tool} ${tool?.ok}`);
  check("answers are in place, after their prompt", entries.findIndex((e) => e.kind === "answer") > entries.indexOf(prompts[0]), entries.map((e) => e.kind).join(","));
  r = await call("GET", `${piPath}/entries`, Cy);
  check("someone outside the repository cannot read it", r.status === 403, `${r.status}`);

  // ── The server's own secret check ──
  const secretLine = JSON.parse(pi.split("\n")[7]);
  secretLine.id = "fixture-secret";
  secretLine.message.content = [{ type: "text", text: `Placeholder with a token ghp_${"A1b2C3d4".repeat(5)}` }];
  const extra = JSON.stringify(secretLine) + "\n";
  const end2 = pi1.end + Buffer.byteLength(extra);
  r = await piece(piPath, A, piStart, pi1.end, end2, extra);
  check("a token that slipped past the machine is replaced and counted", r.status === 200 && r.json?.redactions === 1 && r.json?.prompts === 3, `${r.status} ${r.json?.redactions}`);
  r = await call("GET", `${piPath}/entries`, A);
  const third = (r.json?.entries ?? []).find((e) => e.prompt === 3);
  check("the conversation shows the mark, never the token", third?.text?.includes("[pando:redacted]") && !third?.text?.includes("ghp_"), third?.text?.slice(0, 60));

  // ── Limits ──
  const big = "x".repeat(8_000_001);
  r = await piece(piPath, A, piStart, end2, end2 + 10, big + "\n");
  check("a piece over 8 MB is refused (413), the session unchanged", r.status === 413 && (await call("GET", piPath, A)).json?.end === end2, `${r.status}`);
  r = await piece(piPath, A, piStart, end2, end2 + 10, '{"type":"message"}');
  check("a piece that is not whole lines is refused (400)", r.status === 400, `${r.status}`);

  // ── A long piece: about 7.5 MB of real Pi lines ──
  const lines = pi.split("\n").filter(Boolean).slice(3);
  let longPiece = "";
  let copies = 0;

  // Each copy later than the one before, as a real session's lines are.
  while (longPiece.length < 7_500_000) {
    longPiece += lines.map((l) => {
      const o = JSON.parse(shift(l, (copies + 1) * 30_000));
      o.id = `${o.id}-${copies}`;

      return JSON.stringify(o);
    }).join("\n") + "\n";
    copies++;
  }

  const t0 = Date.now();
  r = await piece(piPath, A, piStart, end2, end2 + longPiece.length, longPiece, { gzip: true });
  check("a 7.5 MB piece is parsed and stored", r.status === 200 && r.json?.prompts === 3 + copies * 2, `${r.status} ${r.json?.prompts} prompts in ${Date.now() - t0} ms`);
  r = await call("GET", `${piPath}/entries`, A);
  check("reading pages through pieces: the first page stops before the long one", r.status === 200 && r.json?.next_cursor === end2, `${r.json?.next_cursor}`);
  r = await call("GET", `${piPath}/entries?from=${end2}`, A);
  check("the next page reads it, prompts numbered on", r.status === 200 && r.json?.entries?.find((e) => e.kind === "prompt")?.prompt === 4, `${r.json?.entries?.length} entries`);

  // ── OpenCode V2: rows as `pando sync` reads them; the cursor is the last seq ──
  const oc = recent(fixture("opencode.jsonl"), 45 * 60_000);
  const ocLines = oc.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ocAgent = ocLines[0].id;
  const ocId = sessionId("opencode", ocAgent);
  const ocPath = `${mb}/sessions/${ocId}`;
  const ocStart = { program: "opencode", agent_id: ocAgent, repo: null, branch: null, parent: null };
  const lastSeq = Math.max(...ocLines.map((l) => l.seq ?? 0));
  r = await piece(ocPath, B, ocStart, 0, lastSeq, oc);
  const ocv = r.json;
  check("bo records an OpenCode V2 session in the repository folder", r.status === 200 && ocv?.end === lastSeq && ocv?.repo === null && ocv?.program === "opencode", `${r.status} ${JSON.stringify(r.json?.error ?? {})}`);
  check("its prompts, tool calls and model come through trajectory and Pando's pass", ocv?.prompts === 2 && ocv?.tool_calls >= 1 && ocv?.models?.[0]?.model === "big-pickle", `${ocv?.prompts} ${ocv?.tool_calls} ${JSON.stringify(ocv?.models)}`);
  check("its last record was 45 minutes ago: inactive", ocv?.state === "inactive", ocv?.state);
  r = await call("GET", `${ocPath}/entries`, A);
  const ocEntries = r.json?.entries ?? [];
  check("its conversation reads: two prompts, a tool call with its result", ocEntries.filter((e) => e.kind === "prompt").length === 2 && ocEntries.some((e) => e.kind === "tool" && e.result), ocEntries.map((e) => e.kind).join(","));

  // ── Lists ──
  r = await call("GET", `${mb}/sessions`, B);
  record("sessions.json", "SessionList", "GET .../sessions", r.status, r.json);
  check("the list has both, newest activity first", r.status === 200 && r.json?.sessions?.map((s) => s.id).join() === [piId, ocId].join(), r.json?.sessions?.map((s) => s.program).join());
  r = await call("GET", `${mb}/sessions?state=active`, B);
  check("?state=active has only the Pi session", r.json?.sessions?.length === 1 && r.json.sessions[0].id === piId, `${r.json?.sessions?.length}`);
  r = await call("GET", `${mb}/sessions?person=@me&agent=opencode`, B);
  check("?person=@me&agent=opencode has bo's OpenCode session", r.json?.sessions?.length === 1 && r.json.sessions[0].id === ocId, `${r.json?.sessions?.length}`);
  r = await call("GET", `${mb}/sessions?limit=1`, B);
  const page2 = await call("GET", `${mb}/sessions?limit=1&cursor=${encodeURIComponent(r.json?.next_cursor ?? "")}`, B);
  check("pages continue from next_cursor", r.json?.sessions?.[0]?.id === piId && page2.json?.sessions?.[0]?.id === ocId && page2.json?.next_cursor === null, `${page2.json?.sessions?.length}`);

  // ── Remove a turn ──
  r = await call("DELETE", `${piPath}/prompts/1`, B);
  check("a member who is not its person or an owner cannot remove a turn (403)", r.status === 403, `${r.status}`);
  const before = (await call("GET", piPath, A)).json;
  r = await call("DELETE", `${piPath}/prompts/1`, A);
  check("ana removes prompt 1's turn: one prompt and its tool call fewer, the mark kept", r.status === 200 && r.json?.prompts === before.prompts - 1 && r.json?.tool_calls === before.tool_calls - 1 && r.json?.removed?.[0]?.prompt === 1 && r.json.removed[0].by === ana, `${r.status} ${r.json?.prompts}/${before.prompts}`);
  r = await call("GET", `${piPath}/entries`, B);
  record("session-entries-removed.json", "SessionEntries", "GET .../sessions/{id}/entries (a removed turn's mark)", r.status, r.json);
  const after = r.json?.entries ?? [];
  check("the conversation shows 'prompt 1 was removed by ana', then prompt 2, numbers kept", after[0]?.kind === "removed" && after[0]?.prompt === 1 && after[0]?.by === ana && after.find((e) => e.kind === "prompt")?.prompt === 2, after.slice(0, 3).map((e) => `${e.kind}${e.prompt ?? ""}`).join(","));
  check("nothing of the removed turn is left in the stored lines", !after.some((e) => e.kind === "tool" && e.input?.includes("placeholder one")), "");
  r = await call("DELETE", `${piPath}/prompts/1`, A);
  check("removing it again is 409", r.status === 409, `${r.status}`);

  // ── Reindex: every number again from the stored pieces ──
  r = await call("POST", `${piPath}/reindex`, A);
  const re = r.json;
  const now = (await call("GET", piPath, A)).json;
  check("a reindex from the stored pieces gives the same session", r.status === 200 && re?.prompts === before.prompts - 1 && re?.tool_calls === now.tool_calls && JSON.stringify(re?.models) === JSON.stringify(now.models) && re?.redactions === 1, `${re?.prompts} ${re?.redactions}`);
  r = await call("GET", `${piPath}/entries`, A);
  check("after it, the numbering still keeps the removed prompt's place", r.json?.entries?.[0]?.kind === "removed" && r.json.entries.find((e) => e.kind === "prompt")?.prompt === 2, "");

  // ── Events ──
  await sleep(500);
  const kinds = live.frames.filter((f) => f.type === "event").map((f) => `${f.kind}:${f.key === piId ? "pi" : "oc"}`);
  check("the socket saw each start and growth", kinds.includes("session.started:pi") && kinds.includes("session.updated:pi") && kinds.includes("session.started:oc"), kinds.slice(0, 6).join(" "));

  // ── Delete ──
  r = await call("DELETE", piPath, B);
  check("a member who is not its person or an owner cannot delete it (403)", r.status === 403, `${r.status}`);
  r = await call("DELETE", ocPath, A);
  check("an owner deletes another person's session", r.status === 200 && r.json?.state === "deleted" && r.json?.deleted_by === ana, `${r.status}`);
  r = await call("DELETE", piPath, A);
  check("ana deletes her own at once", r.status === 200 && r.json?.state === "deleted", `${r.status}`);
  r = await call("GET", piPath, B);
  record("session-deleted.json", "SessionAny", "GET .../sessions/{id} (deleted: its stub)", r.status, r.json);
  check("what stays is who deleted it and when, nothing else", r.status === 200 && Object.keys(r.json ?? {}).sort().join() === "deleted_at,deleted_by,id,state", Object.keys(r.json ?? {}).join());
  r = await call("GET", `${piPath}/entries`, A);
  check("its conversation is gone (410)", r.status === 410, `${r.status}`);
  r = await piece(piPath, A, piStart, 0, cut, first);
  check("the machine is told never to send it again (410 session_deleted)", r.status === 410 && r.json?.error?.code === "session_deleted", `${r.status}`);
  r = await call("GET", `${mb}/sessions`, A);
  check("deleted sessions leave the list", r.json?.sessions?.length === 0, `${r.json?.sessions?.length}`);
  await sleep(300);
  check("the socket saw the deletes", live.frames.filter((f) => f.kind === "session.deleted").length === 2, "");
  const frames = ["session.started", "session.updated", "session.deleted"].map((k) => live.frames.find((f) => f.kind === k));
  record("session-event-frames.json", "MonorepoEventFrame[]", "GET .../events?topics=sessions (WebSocket)", 101, frames);
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  for (const ws of sockets) ws.close();
  await tw.cleanup();
}

const failed = results.filter((x) => !x).length;

console.log(`\n${results.length - failed} passed, ${failed} failed`);

process.exit(failed ? 1 : 0);
