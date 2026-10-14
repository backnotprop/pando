// End to end: Understand (docs/understand/DESIGN.md) on the agents' local
// server (Pando's Worker with its own pando-agents), the scripted model
// writing the page:
//
//   AGENTS_PORT=8927 AGENTS_INSPECTOR=9427 AGENTS_STATE=.state-understand agents/test/serve.sh start
//   AGENTS_URL=http://127.0.0.1:8927 node agents/test/understand.mjs     (RECORD=1 also writes the contract's recordings)
//
// A monorepo with projects/api, a decision in the shared files, an issue, a
// recorded Pi session whose edit became a commit (its Pando-Session line),
// merged into main with a merge commit. Asking "Why?" on the lines: the first
// pass (no model) blames them through the merge to the branch's commit and the
// first commit, reads the session's turn that wrote the file, and the issue and
// decision they name; the scripted model searches and places paragraphs; a
// made-up source is refused. Then nothing found, a commit's Why?, a follow-up,
// members and the session's own credential as the only writer.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BASE, BOOT, call, check, done, git, scrub, sleep, tool } from "./lib.mjs";

const RECORD = process.env.RECORD === "1";

function record(file, schema, route, status, body) {
  if (!RECORD) return;
  writeFileSync(new URL(`../../packages/contract/recorded/${file}`, import.meta.url), `${scrub(JSON.stringify({ schema, route, status, body }, null, 2))}\n`);
}

/** s_ and SHA-256("<program>:<id>")'s first 128 bits in Crockford base32, as Pando derives a session's id. */
function sessionId(program, agentId) {
  let n = BigInt(`0x${createHash("sha256").update(`${program}:${agentId}`).digest("hex").slice(0, 32)}`);
  let out = "";

  for (let i = 0; i < 26; i++) {
    out = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number(n & 31n)] + out;
    n >>= 5n;
  }

  return `s_${out}`;
}

/** A shared file saved over the monorepo's socket, as pando sync saves one: the answer frame. */
async function saveShared(m, path, text) {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/v1/monorepos/${m.full}/meta/socket`, { headers: { authorization: `Bearer ${m.secret}` } });
  const frames = [];

  const until = async (ready) => {
    for (let i = 0; i < 100 && !ready(); i++) await sleep(100);
  };

  ws.onmessage = (e) => e.data !== "pong" && frames.push(JSON.parse(e.data));
  ws.onerror = () => {};

  try {
    await until(() => ws.readyState === 1);
    ws.send(JSON.stringify({ type: "hello", since: 0, machine: "ramos-mbp", client: "understand-test/1" }));
    await until(() => frames.some((f) => f.type === "caught_up"));
    const bytes = Buffer.from(text);
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

    ws.send(JSON.stringify({ type: "save", id: "s1", path, base_version: 0, sha, bytes: bytes.toString("base64") }));
    const answer = (f) => f.id === "s1" && f.type !== "change";

    await until(() => frames.some(answer));

    return frames.find(answer);
  } finally {
    ws.close();
  }
}

/** The page until `ok(page)`, or the last one read. */
async function until(m, n, ok, ms = 90_000) {
  const end = Date.now() + ms;
  let r;

  do {
    r = await call("GET", `/v1/monorepos/${m.full}/understand/${n}`, m.secret);

    if (r.status === 200 && ok(r.json)) return r.json;
    await sleep(500);
  } while (Date.now() < end);

  return r.json;
}

const complete = (p) => p?.status === "complete" || p?.status === "failed";

const id = Date.now().toString(36);

const login = `und-${id}`;

const m = { login, name: `und-${id}`, full: `${login}/und-${id}` };

const LIMIT_V1 = ["export function limited(count: number) {", "  return count > 100;", "}", "", "export const RETRY_AFTER = 7;", "export const RETRY_JITTER = 0.3;", ""].join("\n");

const LIMIT_V2 = ["// 100 a minute per machine (decisions/0010-rate-limit.md).", "export const RATE_LIMIT = 100;", "export const WINDOW_MS = 60_000;", "", "export function limited(count: number) {", "  return count > 100;", "}", "", "export const RETRY_AFTER = 7;", "export const RETRY_JITTER = 0.3;", ""].join("\n");

const DECISION = ["# 0010: The API's rate limit", "", "## Decision", "", "100 requests a minute per machine, counted over a sliding one-minute window.", "A burst above it gets 429 with Retry-After. Bursts of 400 a minute from one", "machine took the API down (#1).", ""].join("\n");

const PROMPT = "Apply decisions/0010-rate-limit.md to the API: 100 a minute per machine, a one-minute window. Put the numbers in src/limit.ts with a comment pointing at the decision. It fixes #1.";

try {
  let r = await call("POST", "/v1/users", BOOT, { login, name: "Ana Lima", email: "tester@pando.invalid", credential_name: "ana-mbp" });
  m.secret = r.json?.credential?.secret;
  check("a person with a machine credential", r.status === 201 && !!m.secret, r.status);
  r = await call("POST", "/v1/monorepos", m.secret, { name: m.name, kind: "monorepo" });
  check("a monorepo", r.status === 201, r.status);
  r = await call("POST", `/v1/monorepos/${m.full}/repos`, m.secret, { path: "projects/api" });
  const repo = r.json?.name;
  const cloneUrl = r.json?.clone_url;
  check("its project projects/api", r.status === 201 && !!repo, r.status);

  // ── The history: the first commit; the decision and the issue; a session's edit, on a branch, merged ──
  const src = mkdtempSync(join(tmpdir(), "pando-understand-"));

  const put = (path, text) => {
    mkdirSync(dirname(join(src, path)), { recursive: true });
    writeFileSync(join(src, path), text);
  };

  git(["init", "-q"], src);
  put("src/limit.ts", LIMIT_V1);
  put("README.md", "# API\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  check("main pushed", git(["push", "-q", cloneUrl, "main"], src, m.secret).ok);
  const first = git(["rev-parse", "HEAD"], src).out.trim();

  r = await saveShared(m, "decisions/0010-rate-limit.md", DECISION);
  check("a decision in the shared files", r?.type === "accepted", JSON.stringify(r));
  r = await call("POST", `/v1/monorepos/${m.full}/issues`, m.secret, { title: "Bursts from the CLI hit 429 and then 502", body: "One machine sent about 400 requests a minute during a sync, and the API answered 502 for everyone." });
  check("issue #1", r.status === 201 && r.json?.number === 1, r.status);

  // A recorded Pi session: the prompt, then its edit of src/limit.ts, a minute ago.
  const agentId = `0199-und-${id}`;
  const sid = sessionId("pi", agentId);
  const t = (s) => new Date(Date.now() - 120_000 + s * 1000).toISOString();

  const lines = [
    { type: "session", version: 3, id: agentId, timestamp: t(0), cwd: "/Users/ana/shop" },
    { type: "model_change", id: "m1", parentId: null, timestamp: t(0), provider: "anthropic", modelId: "claude-opus-5-5" },
    { type: "message", id: "u1", parentId: "m1", timestamp: t(1), message: { role: "user", content: [{ type: "text", text: PROMPT }], timestamp: Date.parse(t(1)) } },
    { type: "message", id: "a1", parentId: "u1", timestamp: t(5), message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "/Users/ana/shop/projects/api/src/limit.ts", oldText: "export function", newText: "// 100 a minute" } }], provider: "anthropic", model: "claude-opus-5-5", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, stopReason: "toolUse", timestamp: Date.parse(t(5)) } },
    { type: "message", id: "r1", parentId: "a1", timestamp: t(6), message: { role: "toolResult", toolCallId: "c1", toolName: "edit", content: [{ type: "text", text: "Edited." }], isError: false, timestamp: Date.parse(t(6)) } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n";

  const headers = { authorization: `Bearer ${m.secret}`, "pando-session": JSON.stringify({ program: "pi", agent_id: agentId, repo, branch: "rate-limit", parent: null }), "content-type": "application/x-ndjson" };
  const piece = await fetch(`${BASE}/v1/monorepos/${m.full}/sessions/${sid}/pieces?at=0&next=${Buffer.byteLength(lines)}`, { method: "POST", headers, body: lines });
  check("a recorded Pi session", piece.status === 200 || piece.status === 201, `${piece.status} ${await piece.text()}`);

  git(["checkout", "-qb", "rate-limit"], src);
  put("src/limit.ts", LIMIT_V2);
  git(["commit", "-qam", `Rate limit: 100 a minute per machine\n\nPando-Session: ${sid}`], src);
  check("the session's commit pushed on rate-limit", git(["push", "-q", cloneUrl, "rate-limit"], src, m.secret).ok);
  const wrote = git(["rev-parse", "HEAD"], src).out.trim();
  r = await call("POST", `/v1/monorepos/${m.full}/repos/${repo}/branches/rate-limit/merge`, m.secret, {});
  check("merged into main with a merge commit", r.status === 200 && r.json?.status === "merged", JSON.stringify(r.json));

  // ── Why? on lines 1 to 7: the first pass, then the scripted model ──
  const place = (blocks) => tool("place", { blocks });

  const question = [
    "Why are lines 1 to 7 of src/limit.ts the way they are?",
    tool("blame", { path: "src/limit.ts", start: 2, end: 2 }),
    tool("search_shared", { words: ["rate limit"] }),
    tool("search_sessions", { words: ["per machine"] }),
    place([
      { id: "p1", type: "paragraph", text: "The limit is 100 a minute because of the decision in [r5], after one machine took the API down ([r4])." },
      { id: "p2", type: "paragraph", text: "Ana asked for exactly this in [r3], and its edit became [r1]." },
      { id: "p3", type: "paragraph", text: "One thing does not match: limited() counts every request, and it came with [r2], before the decision." },
      { id: "made-up", type: "paragraph", text: "A record nobody found: [r9]." },
      { id: "uncited", type: "paragraph", text: "A sentence that rests on nothing." },
    ]),
    place([{ id: "bad id!", type: "paragraph", text: "A block with no usable id [r1]." }]),
    place([
      { id: "p1", type: "paragraph", text: "A second p1 [r1]." },
      { id: "p1", type: "paragraph", text: "And a third [r2]." },
    ]),
  ].join("\n");

  r = await call("POST", `/v1/monorepos/${m.full}/understand`, m.secret, { question, scope: { kind: "lines", repo, path: "src/limit.ts", ref: "main", start: 1, end: 7 }, model: "scripted" });
  check("ask: 201, page 1, building, the first pass already on it", r.status === 201 && r.json?.number === 1 && r.json.status !== "failed" && r.json.asked_by === login && r.json.steps.length === 2, JSON.stringify(r.json?.steps));
  record("understand-asked.json", "UnderstandPage", "POST .../understand (lines; building)", r.status, r.json);
  let page = await until(m, 1, complete);
  check("it completes", page?.status === "complete", JSON.stringify({ status: page?.status, reason: page?.reason }));
  record("understand-page.json", "UnderstandPage", "GET .../understand/{n} (complete)", 200, page);

  const ref = (rid) => page?.refs?.find((x) => x.id === rid);
  check("the lines, blamed through the merge: 1 to 3 on the session's commit, 5 to 7 on the first", page?.lines?.lines?.length === 7 && page.lines.lines.slice(0, 3).every((l) => l.sha === wrote) && page.lines.lines.slice(4).every((l) => l.sha === first), JSON.stringify(page?.lines?.lines?.map((l) => `${l.n}:${l.sha?.slice(0, 7)}`)));
  check("r1: the session's commit, found by blame, with its session and model", ref("r1")?.card?.kind === "commit" && ref("r1").card.sha === wrote && ref("r1").how === "direct" && ref("r1").card.sessions[0] === sid && ref("r1").card.model === "claude-opus-5-5" && ref("r1").card.person === login, JSON.stringify(ref("r1")));
  check("r2: the first commit", ref("r2")?.card?.sha === first && /blame on lines 1 to 7: 3 of 7 lines/.test(ref("r2").found_by ?? ""), JSON.stringify(ref("r2")));
  check("r3: the session, its turn that wrote the file: the prompt and the edit", ref("r3")?.card?.kind === "session" && ref("r3").card.id === sid && ref("r3").card.prompt?.why === "wrote" && ref("r3").card.prompt.text.startsWith("Apply decisions/0010") && ref("r3").card.step?.tool === "edit" && ref("r3").card.step.input === "src/limit.ts", JSON.stringify(ref("r3")));
  check("r4: issue #1, named in the prompt", ref("r4")?.card?.kind === "issue" && ref("r4").card.number === 1 && ref("r4").how === "named", JSON.stringify(ref("r4")));
  check("r5: the decision, named, with its words and who saved it", ref("r5")?.card?.kind === "meta" && ref("r5").card.path === "decisions/0010-rate-limit.md" && /100 requests a minute per machine/.test(ref("r5").card.excerpt?.text ?? "") && ref("r5").card.machine === "ramos-mbp", JSON.stringify(ref("r5")));
  check("the first pass's steps, then the assistant's searches", page?.steps?.map((s) => `${s.by}:${s.tool}`).join() === "first_pass:blame,first_pass:behind,assistant:blame,assistant:search_shared,assistant:search_sessions", page?.steps?.map((s) => `${s.by}:${s.tool}:${s.found}`).join(" | "));
  check("the assistant's own blame (line 2) leaves the page's lines as asked, and finds the same commit, r1", page?.lines?.lines?.length === 7 && page.steps[2].refs.join() === "r1", JSON.stringify(page?.steps?.[2]));
  check("its search found the decision again: the same id, no second record", page?.steps?.[3]?.refs?.includes("r5") && page.refs.filter((x) => x.card?.kind === "meta").length === 1, JSON.stringify(page?.steps?.[3]));
  check("three paragraphs placed, in order, each citing its records", page?.blocks?.map((b) => `${b.id}:${b.cites.join("+")}`).join() === "p1:r5+r4,p2:r3+r1,p3:r2", JSON.stringify(page?.blocks));
  check("a made-up source and an uncited sentence are not on the page", !page?.blocks?.some((b) => b.id === "made-up" || b.id === "uncited"));
  r = await call("GET", `/v1/monorepos/${m.full}/agents/${page?.session}/transcript`, m.secret);
  const places = r.json?.messages?.filter((x) => x.role === "tool").map((x) => x.parts[0]).filter((p) => p.name === "place") ?? [];
  const placed = places[0];
  check("the model is told why: r9 is not a source; a paragraph must cite", /Refused made-up: r9: not a source this page's lookups found/.test(placed?.text ?? "") && /Refused uncited: a paragraph must cite/.test(placed?.text ?? ""), placed?.text);
  check("a block id that is not one is refused whole (400), never renamed", places[1]?.error === true && /Pando refused \(400\) bad_request: blocks\[0\]\.id: "bad id!" is not one/.test(places[1]?.text ?? ""), places[1]?.text);
  check("an id given twice in one request is refused whole (400): nothing replaced", places[2]?.error === true && /blocks\[1\]\.id: "p1" is given twice/.test(places[2]?.text ?? "") && page?.blocks?.[0]?.text.startsWith("The limit is 100"), places[2]?.text);

  // ── The page's writers: its own session only ──
  r = await call("POST", `/v1/monorepos/${m.full}/understand/1/blocks`, m.secret, { blocks: [{ id: "p9", type: "paragraph", text: "Mine [r1]." }] });
  check("the person cannot place blocks (403 not_page_session)", r.status === 403 && r.json?.error?.code === "not_page_session", JSON.stringify(r.json));
  r = await call("POST", `/v1/monorepos/${m.full}/understand/1/lookups`, m.secret, { tool: "issue", args: { number: 1 } });
  check("nor run lookups", r.status === 403, r.status);

  // ── Members: anyone can open it; only its asker follows up ──
  r = await call("POST", "/v1/users", BOOT, { login: `${login}-b`, name: "Bo", email: `b-${login}@pando.invalid`, credential_name: "bo-mbp" });
  const bo = r.json?.credential?.secret;
  await call("PUT", `/v1/monorepos/${m.full}/members/${login}-b`, m.secret, { role: "member" });
  r = await call("GET", `/v1/monorepos/${m.full}/understand/1`, bo);
  check("another member opens the page", r.status === 200 && r.json?.blocks?.length === 3, r.status);
  r = await call("POST", `/v1/monorepos/${m.full}/understand/1/follow-ups`, bo, { question: "Who decided?" });
  check("but cannot ask a follow-up (403 not_asker)", r.status === 403 && r.json?.error?.code === "not_asker", JSON.stringify(r.json));
  r = await call("POST", "/v1/users", BOOT, { login: `${login}-c`, name: "Cy", email: `c-${login}@pando.invalid`, credential_name: "cy-mbp" });
  r = await call("GET", `/v1/monorepos/${m.full}/understand/1`, r.json?.credential?.secret);
  check("someone not a member cannot open it", r.status === 403 || r.status === 404, r.status);

  // ── A follow-up: the next revision, a paragraph replaced ──
  r = await call("POST", `/v1/monorepos/${m.full}/understand/1/follow-ups`, m.secret, { question: ["Should limited() count per machine?", place([{ id: "p3", type: "paragraph", text: "Yes: the decision counts per machine ([r5]); limited() came with [r2], before it." }])].join("\n") });
  check("follow-up: revision 2, building", r.status === 200 && r.json?.revision === 2, JSON.stringify({ status: r.status, revision: r.json?.revision, error: r.json?.error }));
  page = await until(m, 1, (p) => p.status === "complete" && p.blocks.find((b) => b.id === "p3")?.revision === 2);
  check("p3 replaced in place, marked revision 2", page?.blocks?.map((b) => b.id).join() === "p1,p2,p3" && page.blocks[2].text.startsWith("Yes:") && page.blocks[2].revision === 2, JSON.stringify(page?.blocks));

  // ── Nothing found ──
  r = await call("POST", `/v1/monorepos/${m.full}/understand`, m.secret, {
    question: ["Why are lines 9 to 10 of src/limit.ts the way they are?", tool("search_shared", { words: ["RETRY_AFTER", "retry after"] }), place([{ id: "n1", type: "nothing", text: "They came with the first commit [r1], which names no session, issue or shared file, and no shared file mentions RETRY_AFTER." }])].join("\n"),
    scope: { kind: "lines", repo, path: "src/limit.ts", ref: "main", start: 9, end: 10 },
    model: "scripted",
  });
  page = await until(m, r.json?.number ?? 2, complete);
  check("nothing found: the first commit alone, nothing behind it", page?.status === "complete" && page.refs.length === 1 && page.refs[0].card.sha === first && page.lines.lines.every((l) => l.sha === first), JSON.stringify(page?.refs?.map((x) => x.id)));
  check("its search found nothing, and says in how many files", /nothing in \d+ files?/.test(page?.steps?.find((s) => s.tool === "search_shared")?.found ?? ""), JSON.stringify(page?.steps));
  check("one block: nothing, citing the commit it did find", page?.blocks?.length === 1 && page.blocks[0].type === "nothing" && page.blocks[0].cites.join() === "r1", JSON.stringify(page?.blocks));
  record("understand-nothing.json", "UnderstandPage", "GET .../understand/{n} (nothing found)", 200, page);

  // ── Why? on a commit ──
  r = await call("POST", `/v1/monorepos/${m.full}/understand`, m.secret, { question: `Why was this change made?\n${place([{ id: "p1", type: "paragraph", text: "To apply the decision [r4] that [r2] asked for." }])}`, scope: { kind: "commit", repo, sha: wrote }, model: "scripted" });
  page = await until(m, r.json?.number ?? 3, complete);
  check("a commit's Why?: the commit, its session, the issue and decision it names", page?.refs?.map((x) => x.card?.kind).join() === "commit,session,issue,meta" && page.blocks.length === 1, JSON.stringify(page?.refs?.map((x) => `${x.id}:${x.card?.kind}`)));

  // ── A free question: the first pass searches ──
  r = await call("POST", `/v1/monorepos/${m.full}/understand`, m.secret, { question: "Why is the rate limit 100 a minute?", model: "scripted" });
  page = await until(m, r.json?.number ?? 4, complete);
  check("a free question: the first pass searches the shared files and the sessions", page?.steps?.slice(0, 2).map((s) => s.tool).join() === "search_shared,search_sessions" && page.refs.some((x) => x.card?.kind === "meta") && page.refs.some((x) => x.card?.kind === "session" && x.card.prompt?.why === "match"), JSON.stringify(page?.steps));

  // ── The list, and the session's place in the Agents tab ──
  r = await call("GET", `/v1/monorepos/${m.full}/understand`, m.secret);
  check("the list, newest first", r.status === 200 && r.json?.pages?.map((p) => p.number).join() === "4,3,2,1" && r.json.pages[3].cited === 5, JSON.stringify(r.json?.pages?.map((p) => [p.number, p.status, p.sources, p.cited])));
  record("understand-list.json", "UnderstandList", "GET .../understand", r.status, r.json);
  r = await call("GET", `/v1/monorepos/${m.full}/agents`, m.secret);
  check("Understand's sessions are not in the Agents tab", r.json?.sessions?.length === 0, JSON.stringify(r.json?.sessions?.map((s) => s.kind)));
  r = await call("GET", `/v1/monorepos/${m.full}/events?topics=understand:1&limit=100`, m.secret);
  const frames = r.json?.events?.filter((e) => e.kind === "understand.updated") ?? [];
  check("its row events, on topic understand:1", frames.length > 3 && frames.every((f) => f.number === 1), r.status);
  record("understand-event-frames.json", "MonorepoEventFrame[]", "GET .../events?topics=understand:1 (understand.updated)", 200, frames.slice(-2).map((f) => ({ type: "event", ...f })));

  // ── A member's chat is theirs alone: its agent and its sandbox's sessions never reach a page, nor a search ──
  r = await call("POST", `/v1/monorepos/${m.full}/assistant`, bo, { model: "scripted", prompt: "Where is the rate limit window kept?" });
  const chatN = r.json?.number;

  check("Bo's chat with the assistant", r.status === 201 && r.json?.kind === "chat", JSON.stringify(r.json));
  // A machine named as that chat's sandbox (cloud-<n>), recording a session that names the window.
  r = await call("POST", "/v1/user/credentials", bo, { name: `cloud-${chatN}`, kind: "sandbox" });
  const chatAgentId = `0199-chat-${id}`;
  const chatSid = sessionId("pi", chatAgentId);

  const chatLines = [
    { type: "session", version: 3, id: chatAgentId, timestamp: t(0), cwd: "/workspace/repo" },
    { type: "message", id: "u1", parentId: null, timestamp: t(1), message: { role: "user", content: [{ type: "text", text: "Keep the window private: sixty seconds a machine, not per person." }], timestamp: Date.parse(t(1)) } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n";

  const chatPiece = await fetch(`${BASE}/v1/monorepos/${m.full}/sessions/${chatSid}/pieces?at=0&next=${Buffer.byteLength(chatLines)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${r.json?.secret}`, "pando-session": JSON.stringify({ program: "pi", agent_id: chatAgentId, repo, branch: "chat-note", parent: null }), "content-type": "application/x-ndjson" },
    body: chatLines,
  });

  check("a session recorded from the chat's machine", chatPiece.status === 200 || chatPiece.status === 201, chatPiece.status);
  // A commit made from that machine, naming that session.
  git(["checkout", "-qb", "chat-note"], src);
  put("README.md", "# API\n\nThe rate limit window is sixty seconds.\n");
  git(["commit", "-qam", `Note the window\n\nPando-Session: ${chatSid}\nPando-Machine: cloud-${chatN}`], src);
  check("its commit pushed on chat-note", git(["push", "-q", cloneUrl, "chat-note"], src, m.secret).ok);
  r = await call("POST", `/v1/monorepos/${m.full}/understand`, m.secret, {
    question: ["Why is line 3 of README.md the way it is?", tool("search_sessions", { words: ["window private"] })].join("\n"),
    scope: { kind: "lines", repo, path: "README.md", ref: "chat-note", start: 3, end: 3 },
    model: "scripted",
  });
  page = await until(m, r.json?.number ?? 5, complete);
  check("the chat's commit is on the page, as git has it", page?.refs?.[0]?.card?.kind === "commit" && page.refs[0].card.machine === `cloud-${chatN}`, JSON.stringify(page?.refs?.[0]));
  check("but not the chat (no agent card) nor the session from its sandbox", !page?.refs?.some((x) => x.card?.kind === "agent" || (x.card?.kind === "session" && x.card.id === chatSid)), JSON.stringify(page?.refs?.map((x) => `${x.id}:${x.card?.kind}`)));
  check("and search_sessions does not find it", page?.steps?.find((x) => x.tool === "search_sessions")?.found.startsWith("nothing"), JSON.stringify(page?.steps?.find((x) => x.tool === "search_sessions")));

  // ── Refusals ──
  r = await call("POST", `/v1/monorepos/${m.full}/understand`, m.secret, { question: " " });
  check("an empty question: 400", r.status === 400, r.status);
  r = await call("POST", `/v1/monorepos/${m.full}/understand`, m.secret, { question: "Why?", scope: { kind: "lines", repo, path: "src/limit.ts", ref: "no-such-branch", start: 1, end: 2 } });
  check("a scope on a branch that does not exist: 400", r.status === 400 && /no branch/.test(r.json?.error?.message ?? ""), JSON.stringify(r.json));
} catch (error) {
  check("the run reached its end", false, scrub(error.stack ?? error));
} finally {
  if (m.secret) await call("DELETE", `/v1/monorepos/${m.full}?confirm=${m.full}`, m.secret).catch(() => null);
}

done();
