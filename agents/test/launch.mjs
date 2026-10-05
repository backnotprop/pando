// End to end, stage 2: launching an agent through Pando's own routes. The
// launch mints a sandbox credential for the person (cloud-<n>), records the
// session in the monorepo object and starts it in pando-agents; each change
// of its state comes back as an agent.updated event. Who may send it
// messages and stop it, and revoking its credential, are checked too. It
// records the contract's agent responses and frames
// (packages/contract/recorded/agent*.json).
//
//   agents/test/serve.sh start && node agents/test/launch.mjs

import { writeFileSync } from "node:fs";
import { BASE, BOOT, call, check, done, makeRepo, say, scrub, sleep, tool, untilSettled } from "./lib.mjs";

const OUT = new URL("../../packages/contract/recorded/", import.meta.url);

function record(file, schema, route, status, body) {
  writeFileSync(new URL(file, OUT), `${scrub(JSON.stringify({ schema, route, status, body }, null, 2))}\n`);
}

const lastTool = (tr) => tr.messages.filter((m) => m.role === "tool").at(-1)?.parts[0]?.text ?? "";

const t = await makeRepo("agents-s2", { "README.md": "# Launch\n\nThis line has a tpyo.\n" });

const frames = [];

const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/v1/monorepos/${t.full}/events?topics=agents`, { headers: { authorization: `Bearer ${t.secret}` } });

ws.onmessage = (m) => {
  if (m.data !== "pong") frames.push(JSON.parse(m.data));
};

try {
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("the event socket did not open"));
  });

  // ── Launch ──
  const prompt = [
    "Fix the README typo and push.",
    tool("edit", { path: "README.md", edits: [{ oldText: "tpyo", newText: "typo" }] }),
    tool("bash", { command: "git commit -qam 'Fix the README typo' && git push -q origin agent/1 2>&1; echo pushed=$?" }),
  ].join("\n");

  let r = await call("POST", `/v1/monorepos/${t.full}/agents`, t.secret, { prompt, model: "scripted" });

  record("agent-launched.json", "AgentSession", "POST /v1/monorepos/{owner}/{monorepo}/agents", r.status, r.json);
  check("launch: 201, session #1 working on agent/1 as cloud-1, acting as the person", r.status === 201 && r.json?.number === 1 && r.json?.status === "working" && r.json?.branch === "agent/1" && r.json?.machine === "cloud-1" && r.json?.launched_by === t.login && r.json?.program === "pi", scrub(JSON.stringify(r.json)));

  r = await untilSettled(t, 1);
  record("agent.json", "AgentSession", "GET /v1/monorepos/{owner}/{monorepo}/agents/{n}", r.status, r.json);
  check("its object reports the run's end: waiting, workspace mount", r.json?.status === "waiting" && r.json?.workspace === "mount", JSON.stringify(r.json));

  r = await call("GET", `/v1/monorepos/${t.full}/agents/1/transcript`, t.secret);
  record("agent-transcript.json", "AgentTranscript", "GET /v1/monorepos/{owner}/{monorepo}/agents/{n}/transcript", r.status, r.json);
  check("the transcript: the prompt, two tool calls and results, the answer", r.status === 200 && r.json.messages.length >= 6 && /pushed=0/.test(lastTool(r.json)), lastTool(r.json));

  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches`, t.secret);
  check("Pando lists agent/1", JSON.stringify(r.json).includes('"agent/1"'));
  r = await call("GET", `/v1/monorepos/${t.full}/machines`, t.secret);
  check("Machines shows cloud-1, a sandbox", /"cloud-1"/.test(JSON.stringify(r.json)) && /sandbox/.test(JSON.stringify(r.json)), scrub(JSON.stringify(r.json)).slice(0, 300));
  r = await call("GET", "/v1/user/credentials", t.secret);
  const cred = r.json.credentials.find((c) => c.name === "cloud-1");
  check("the person's credentials list cloud-1, kind sandbox", cred?.kind === "sandbox", scrub(JSON.stringify(cred)));

  // ── Who may do what ──
  r = await call("POST", "/v1/users", BOOT, { login: `${t.login}-b`, name: "Member B", email: `b-${t.login}@pando.invalid`, credential_name: "b-mbp" });
  const b = r.json?.credential?.secret;
  r = await call("PUT", `/v1/monorepos/${t.full}/members/${t.login}-b`, t.secret, { role: "member" });
  check("a second member", r.status === 200 || r.status === 201, r.status);
  r = await call("GET", `/v1/monorepos/${t.full}/agents`, b);
  record("agents.json", "AgentSessionList", "GET /v1/monorepos/{owner}/{monorepo}/agents", r.status, r.json);
  check("every member sees the repository's sessions", r.status === 200 && r.json.sessions.length === 1 && r.json.next_before === null);
  r = await call("POST", `/v1/monorepos/${t.full}/agents/1/messages`, b, { prompt: "do something else" });
  record("error-403-agent.json", "ErrorBody", "POST /v1/monorepos/{owner}/{monorepo}/agents/{n}/messages (not the launcher)", r.status, r.json);
  check("only the person who launched it sends it messages (403 not_launcher)", r.status === 403 && r.json?.error?.code === "not_launcher", JSON.stringify(r.json));
  r = await call("POST", `/v1/monorepos/${t.full}/agents/1/stop`, b);
  check("a member who did not launch it cannot stop it", r.status === 403);
  r = await call("GET", `/v1/monorepos/${t.full}/agents`, `pando_${"0".repeat(40)}`);
  check("no credential, no sessions (401)", r.status === 401);

  // ── A follow-up, then Stop ──
  r = await call("POST", `/v1/monorepos/${t.full}/agents/1/messages`, t.secret, { prompt: tool("bash", { command: "git log --oneline -1" }) });
  check("a follow-up from the launcher: working again", r.status === 200 && r.json?.status === "working", JSON.stringify(r.json));
  r = await untilSettled(t, 1);
  check("and waiting after it", r.json?.status === "waiting");
  r = await call("POST", `/v1/monorepos/${t.full}/agents/1/stop`, t.secret);
  record("agent-stopped.json", "AgentSession", "POST /v1/monorepos/{owner}/{monorepo}/agents/{n}/stop", r.status, r.json);
  check("Stop: stopped, with who stopped it", r.json?.status === "stopped" && r.json?.reason === `stopped by ${t.login}`, JSON.stringify(r.json));

  // ── Revoking its credential cuts it off ──
  r = await call("DELETE", `/v1/user/credentials/${cred.id}`, t.secret);
  check("revoke cloud-1", r.status === 204, r.status);
  await sleep(16_000); // auth answers are cached per isolate for 15 s
  r = await call("POST", `/v1/monorepos/${t.full}/agents/1/messages`, t.secret, { prompt: tool("bash", { command: "git ls-remote origin 2>&1 | tail -1" }) });
  r = await untilSettled(t, 1);
  const after = lastTool((await call("GET", `/v1/monorepos/${t.full}/agents/1/transcript`, t.secret)).json);
  check("after the revoke, the sandbox can no longer reach the repository", /401|could not read Username|Authentication/i.test(after), after);

  await sleep(1000);
  const agentFrames = frames.filter((f) => f.kind === "agent.updated");
  record("agent-event-frames.json", "MonorepoEventFrame[]", "GET .../events?topics=agents (WebSocket)", 101, agentFrames);
  const seen = agentFrames.map((f) => f.row.status).join(" ");
  check("agent.updated frames follow every state: working, waiting, working, waiting, stopped", /^working( working)* waiting working waiting stopped/.test(seen), seen);
} catch (error) {
  check("the run reached its end", false, scrub(error.stack ?? error));
} finally {
  ws.close();
  const r = await call("DELETE", `/v1/monorepos/${t.full}?confirm=${t.full}`, t.secret);
  check(`cleanup: ${t.full} is deleted`, r.status === 204, r.status);
  say("");
}

done();
