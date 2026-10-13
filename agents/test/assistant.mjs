// End to end, stage 8: the repository assistant. A chat answers from Pando's
// read tools with no sandbox: no container starts. It is its person's alone.
// Asked for a change, it starts a branch the person named (start_branch), works in a
// sandbox, and merges. One session per chat, per person.
//
// In a monorepo of two projects (projects/web, projects/api): a chat with no
// project is about the whole repository (repo null): it reads the shared
// files and either project, and names the project when it starts a branch;
// a chat with a project chosen reads that project and works in it. It
// records the contract's whole-repository chat (agent-chat-repository.json).
//
//   agents/test/serve.sh start && node agents/test/assistant.mjs

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BASE, BOOT, call, check, done, git, makeRepo, scrub, sleep, tool, untilSettled } from "./lib.mjs";

const OUT = new URL("../../packages/contract/recorded/", import.meta.url);

function record(file, schema, route, status, body) {
  writeFileSync(new URL(file, OUT), `${scrub(JSON.stringify({ schema, route, status, body }, null, 2))}\n`);
}

const toolsOf = async (t, n, secret = t.secret) => (await call("GET", `/v1/monorepos/${t.full}/agents/${n}/transcript`, secret)).json.messages.filter((m) => m.role === "tool").map((m) => m.parts[0]);

const t = await makeRepo("agents-s8", { "README.md": "# Assistant\n", "src/app.js": "export const answer = 42;\n" });

try {
  // ── A question ──
  let r = await call("POST", `/v1/monorepos/${t.full}/assistant`, t.secret, {
    model: "scripted",
    prompt: ["What does src/app.js export?", tool("list_files", { path: "src" }), tool("read_file", { path: "src/app.js" }), tool("bash", { command: "ls" })].join("\n"),
  });

  check("a new chat: 201, kind chat, with no branch", r.status === 201 && r.json?.kind === "chat" && r.json?.branch === null, scrub(JSON.stringify(r.json)));
  r = await untilSettled(t, 1);
  check("it answers and waits, with no sandbox started", r.json?.status === "waiting" && r.json?.workspace === null, JSON.stringify(r.json));
  let res = await toolsOf(t, 1);
  check("list_files and read_file answer from the server", /^app\.js$/m.test(res[0]?.text ?? "") && /export const answer = 42;/.test(res[1]?.text ?? ""), `${res[0]?.text}\n${res[1]?.text}`);
  check("bash is not offered before start_branch", res[2]?.name === "bash" && res[2]?.error === true, res[2]?.text);
  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches`, t.secret);
  check("no branch was made for a question", (r.json?.branches ?? []).length === 0, JSON.stringify(r.json?.branches?.map((b) => b.name)));

  // ── Its person's alone ──
  r = await call("GET", `/v1/monorepos/${t.full}/assistant`, t.secret);
  check("GET .../assistant lists the person's chat, with its first message", r.json?.sessions?.length === 1 && r.json.sessions[0].number === 1 && r.json.sessions[0].first_message?.startsWith("What does src/app.js export?"), r.json?.sessions?.[0]?.first_message);
  r = await call("GET", `/v1/monorepos/${t.full}/agents`, t.secret);
  check("the Agents tab does not list chats", r.json?.sessions?.length === 0, JSON.stringify(r.json));
  r = await call("POST", "/v1/users", BOOT, { login: `${t.login}-b`, name: "Member B", email: `b-${t.login}@pando.invalid`, credential_name: "b-mbp" });
  const b = r.json?.credential?.secret;
  await call("PUT", `/v1/monorepos/${t.full}/members/${t.login}-b`, t.secret, { role: "member" });
  r = await call("GET", `/v1/monorepos/${t.full}/assistant`, b);
  check("another member has no chats", r.status === 200 && r.json?.sessions?.length === 0);
  const other = await Promise.all([`/agents/1`, `/agents/1/transcript`].map((p) => call("GET", `/v1/monorepos/${t.full}${p}`, b)));
  check("and cannot open this one (404)", other.every((x) => x.status === 404), other.map((x) => x.status).join(" "));
  r = await call("POST", `/v1/monorepos/${t.full}/agents/1/messages`, b, { prompt: "hello" });
  check("nor send it a message", r.status === 404, r.status);

  // ── A change: the branch is named by the person, never by the model ──
  // The scripted model reads its calls from the message; this one's name is JSON-escaped, so the person's text does not say it.
  r = await call("POST", `/v1/monorepos/${t.full}/agents/1/messages`, t.secret, { prompt: ["Add a line to the README and merge it.", tool("start_branch", { name: "made-up-name" }).replace('"made', String.fromCharCode(34, 92) + "u006dade")].join("\n") });
  r = await untilSettled(t, 1);
  res = await toolsOf(t, 1);
  check("start_branch refuses a name the person did not write", res.at(-1)?.name === "start_branch" && res.at(-1)?.error === true && /has not named "made-up-name"/.test(res.at(-1)?.text ?? ""), res.at(-1)?.text);
  check("and no sandbox started", r.json?.workspace === null && r.json?.branch === null, JSON.stringify(r.json));
  r = await call("POST", `/v1/monorepos/${t.full}/agents/1/messages`, t.secret, {
    prompt: [
      "Call it readme-line.",
      tool("start_branch", { name: "readme-line" }),
      tool("bash", { command: "git branch --show-current && echo 'Changed by the assistant.' >> README.md && git commit -qam 'A line from the assistant' && git push -q origin readme-line 2>&1; echo pushed=$?" }),
      tool("merge", {}),
    ].join("\n"),
  });
  r = await untilSettled(t, 1);
  check("named by the person: the chat works on readme-line, with a sandbox", r.json?.status === "waiting" && r.json?.workspace === "mount" && r.json?.branch === "readme-line", JSON.stringify(r.json));
  res = await toolsOf(t, 1);
  const [start, bash, merge] = res.slice(-3);
  check("start_branch, then bash on readme-line, then merge", start?.name === "start_branch" && !start.error && /^readme-line$/m.test(bash?.text ?? "") && /pushed=0/.test(bash?.text ?? "") && merge?.name === "merge" && !merge.error, res.slice(-3).map((p) => `${p.name}: ${p.text.slice(0, 120)}`).join("\n"));
  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/files/README.md`, t.secret);
  check("main has the change", /Changed by the assistant\./.test(r.text), r.text);

  // ── One session per chat ──
  r = await call("POST", `/v1/monorepos/${t.full}/assistant`, t.secret, { model: "scripted", prompt: "A new question." });
  check("a second chat is its own session, with no branch", r.status === 201 && r.json?.number === 2 && r.json?.branch === null);
  await untilSettled(t, 2);
  r = await call("GET", `/v1/monorepos/${t.full}/assistant`, t.secret);
  check("the person's chats, newest first", r.json?.sessions?.map((s) => s.number).join(",") === "2,1");
} catch (error) {
  check("the run reached its end", false, scrub(error.stack ?? error));
} finally {
  const r = await call("DELETE", `/v1/monorepos/${t.full}?confirm=${t.full}`, t.secret);
  check(`cleanup: ${t.full} is deleted`, r.status === 204, r.status);
}

// ── A monorepo of two projects ──

/** A project of the monorepo m with these files on main. */
async function project(m, path, files) {
  const r = await call("POST", `/v1/monorepos/${m.full}/repos`, m.secret, { path });
  const src = mkdtempSync(join(tmpdir(), "pando-agents-s8-"));
  git(["init", "-q"], src);

  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(src, file)), { recursive: true });
    writeFileSync(join(src, file), content);
  }

  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  check(`${path}, its main pushed`, r.status === 201 && git(["push", "-q", r.json?.clone_url, "main"], src, m.secret).ok, r.status);

  return r.json?.name;
}

/** A shared file saved over the monorepo's socket, as pando sync saves one: the answer frame. */
async function saveShared(m, path, text) {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/v1/monorepos/${m.full}/meta/socket`, { headers: { authorization: `Bearer ${m.secret}` } });
  const frames = [];

  /** Waits up to 10 s for `ready`. */
  const until = async (ready) => {
    for (let i = 0; i < 100 && !ready(); i++) await sleep(100);
  };

  ws.onmessage = (e) => e.data !== "pong" && frames.push(JSON.parse(e.data));
  ws.onerror = () => {};

  try {
    await until(() => ws.readyState === 1);
    ws.send(JSON.stringify({ type: "hello", since: 0, machine: "tester-mbp", client: "agents-s8-test/1" }));
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

const m = { ...t, name: `${t.name}-mono`, full: `${t.login}/${t.name}-mono` };

try {
  let r = await call("POST", "/v1/monorepos", m.secret, { name: m.name, kind: "monorepo" });
  check("a monorepo", r.status === 201, r.status);
  const web = await project(m, "projects/web", { "src/app.js": "export const page = 'web';\n" });
  const api = await project(m, "projects/api", { "src/server.js": "export const port = 8080;\n" });
  r = await saveShared(m, "plans/plan.md", "Ship the API first.\n");
  check("a shared file, plans/plan.md", r?.type === "accepted", JSON.stringify(r));

  // ── No project chosen: the whole repository ──
  r = await call("POST", `/v1/monorepos/${m.full}/agents`, m.secret, { model: "scripted", prompt: "Do something.", branch: "some-change" });
  check("a task still names its project (400)", r.status === 400 && /repo: which project/.test(r.json?.error?.message ?? ""), scrub(JSON.stringify(r.json)));
  r = await call("POST", `/v1/monorepos/${m.full}/assistant`, m.secret, {
    model: "scripted",
    prompt: ["What is the plan, and which port does the API use?", tool("list_files", {}), tool("read_file", { path: "plans/plan.md" }), tool("read_file", { path: "src/server.js", repo: api }), tool("branch_diff", {})].join("\n"),
  });
  record("agent-chat-repository.json", "AgentSession", "POST /v1/monorepos/{owner}/{monorepo}/assistant (no repo, two projects)", r.status, r.json);
  check("a chat with no project: 201, about the whole repository (repo null)", r.status === 201 && r.json?.kind === "chat" && r.json?.repo === null && r.json?.branch === null, scrub(JSON.stringify(r.json)));
  const whole = r.json?.number;
  r = await untilSettled(m, whole);
  check("it answers and waits, with no sandbox", r.json?.status === "waiting" && r.json?.workspace === null && r.json?.repo === null, JSON.stringify(r.json));
  let res = await toolsOf(m, whole);
  check("list_files with no project lists the shared files", /^plans\/$/m.test(res[0]?.text ?? "") && !res[0]?.error, res[0]?.text);
  check("read_file with no project reads a shared file", /Ship the API first\./.test(res[1]?.text ?? ""), res[1]?.text);
  check("read_file with repo reads that project", /export const port = 8080;/.test(res[2]?.text ?? ""), res[2]?.text);
  check("branch_diff with no project asks for one", res[3]?.error === true && /Give repo/.test(res[3]?.text ?? ""), res[3]?.text);
  r = await call("GET", `/v1/monorepos/${m.full}/assistant`, m.secret);
  check("the Chats list shows it with no project", r.json?.sessions?.[0]?.number === whole && r.json.sessions[0].repo === null, JSON.stringify(r.json?.sessions?.[0]));

  r = await call("POST", `/v1/monorepos/${m.full}/agents/${whole}/messages`, m.secret, { prompt: ["Call it api-note.", tool("start_branch", { name: "api-note" })].join("\n") });
  r = await untilSettled(m, whole);
  res = await toolsOf(m, whole);
  check("start_branch with no project asks which one", res.at(-1)?.name === "start_branch" && res.at(-1)?.error === true && /Give repo.*projects-api.*projects-web|Give repo.*projects-web.*projects-api/.test(res.at(-1)?.text ?? ""), res.at(-1)?.text);
  r = await call("POST", `/v1/monorepos/${m.full}/agents/${whole}/messages`, m.secret, {
    prompt: ["Call it api-note, in the API.", tool("start_branch", { name: "api-note", repo: api }), tool("bash", { command: "pwd && git branch --show-current" })].join("\n"),
  });
  r = await untilSettled(m, whole);
  res = await toolsOf(m, whole);
  check("named with its project: the chat works in projects/api on api-note", r.json?.status === "waiting" && r.json?.repo === api && r.json?.branch === "api-note" && r.json?.workspace !== null, JSON.stringify(r.json));
  check("its sandbox is api's worktree", /\/workspace\/repo\/projects\/api\/worktrees\/api-note$/m.test(res.at(-1)?.text ?? "") && /^api-note$/m.test(res.at(-1)?.text ?? ""), res.at(-1)?.text);

  // ── A project chosen ──
  r = await call("POST", `/v1/monorepos/${m.full}/assistant`, m.secret, {
    model: "scripted",
    repo: web,
    prompt: ["What does the app export?", tool("read_file", { path: "src/app.js" })].join("\n"),
  });
  check("a chat about projects/web", r.status === 201 && r.json?.repo === web && r.json?.branch === null, scrub(JSON.stringify(r.json)));
  const chosen = r.json?.number;
  await untilSettled(m, chosen);
  res = await toolsOf(m, chosen);
  check("read_file with no repo reads projects/web", /export const page = 'web';/.test(res[0]?.text ?? ""), res[0]?.text);
  r = await call("POST", `/v1/monorepos/${m.full}/agents/${chosen}/messages`, m.secret, {
    prompt: ["Call it web-note.", tool("start_branch", { name: "web-note" }), tool("bash", { command: "pwd && git branch --show-current" })].join("\n"),
  });
  r = await untilSettled(m, chosen);
  res = await toolsOf(m, chosen);
  check("start_branch works in projects/web", r.json?.repo === web && r.json?.branch === "web-note" && /\/workspace\/repo\/projects\/web\/worktrees\/web-note$/m.test(res.at(-1)?.text ?? ""), `${JSON.stringify(r.json)}\n${res.at(-1)?.text}`);
  await Promise.all([whole, chosen].map((n) => call("POST", `/v1/monorepos/${m.full}/agents/${n}/stop`, m.secret)));
} catch (error) {
  check("the monorepo run reached its end", false, scrub(error.stack ?? error));
} finally {
  const r = await call("DELETE", `/v1/monorepos/${m.full}?confirm=${m.full}`, m.secret);
  check(`cleanup: ${m.full} is deleted`, r.status === 204, r.status);
}

done();
