// End to end: the live view's socket. A member opens GET .../agents/{n}/live
// while the agent works; the frames rebuild the transcript exactly as GET
// .../transcript answers it at the end, the first from 0 and each later one
// appending. A person who is not a member is refused. It records the frames
// for the contract (packages/contract/recorded/agent-live-frames.json).
//
//   agents/test/serve.sh start && node agents/test/live.mjs

import { writeFileSync } from "node:fs";
import { BASE, BOOT, call, check, done, makeRepo, scrub, sleep, tool, untilSettled } from "./lib.mjs";

const OUT = new URL("../../packages/contract/recorded/", import.meta.url);

function open(path, secret) {
  const s = { frames: [], opened: false, failed: null };

  s.ws = new WebSocket(`${BASE.replace(/^http/, "ws")}${path}`, { headers: { authorization: `Bearer ${secret}` } });
  s.ws.onopen = () => {
    s.opened = true;
  };

  s.ws.onerror = (e) => {
    s.failed = e?.message ?? "error";
  };

  s.ws.onmessage = (m) => s.frames.push(JSON.parse(m.data));

  return s;
}

const t = await makeRepo("agents-live", { "README.md": "# Live\n" });

try {
  const prompt = ["Show the live view.", tool("bash", { command: "echo first" }), tool("bash", { command: "sleep 3; echo after-a-while" }), tool("read", { path: "README.md" })].join("\n");
  let r = await call("POST", `/v1/monorepos/${t.full}/agents`, t.secret, { prompt, model: "scripted" });
  check("launched", r.status === 201, r.status);
  const live = open(`/v1/monorepos/${t.full}/agents/1/live`, t.secret);
  await untilSettled(t, 1);
  await sleep(1000);
  live.ws.close();
  check("a member's socket opens", live.opened, live.failed);

  const tr = (await call("GET", `/v1/monorepos/${t.full}/agents/1/transcript`, t.secret)).json.messages;
  const rebuilt = [];
  let ordered = true;

  for (const f of live.frames) {
    ordered &&= f.type === "messages" && f.from === rebuilt.length;
    rebuilt.push(...f.messages);
  }

  check("the first frame starts at 0 and every later one appends", live.frames.length >= 2 && ordered, live.frames.map((f) => `${f.from}+${f.messages.length}`).join(" "));
  check("the frames rebuild the transcript exactly", JSON.stringify(rebuilt) === JSON.stringify(tr), `${rebuilt.length} from frames, ${tr.length} in the transcript`);
  check("the slow command's output came in a frame of its own, while the agent worked", live.frames.some((f) => f.messages.some((m) => m.parts.some((p) => p.type === "tool-result" && /after-a-while/.test(p.text)))) && live.frames.length >= 3);
  writeFileSync(new URL("agent-live-frames.json", OUT), `${scrub(JSON.stringify({ schema: "AgentLiveFrame[]", route: "GET /v1/monorepos/{owner}/{monorepo}/agents/{n}/live (WebSocket)", status: 101, body: live.frames }, null, 2))}\n`);

  // A late watcher gets everything so far in one frame.
  const late = open(`/v1/monorepos/${t.full}/agents/1/live`, t.secret);
  await sleep(1500);
  late.ws.close();
  check("a socket opened later gets the whole transcript in its first frame", late.frames[0]?.from === 0 && late.frames[0]?.messages.length === tr.length, late.frames.map((f) => `${f.from}+${f.messages.length}`).join(" "));

  // Not a member: refused before anything reaches the session.
  r = await call("POST", "/v1/users", BOOT, { login: `${t.login}-x`, name: "Outsider", email: `x-${t.login}@pando.invalid`, credential_name: "x-mbp" });
  const outsider = open(`/v1/monorepos/${t.full}/agents/1/live`, r.json?.credential?.secret);
  await sleep(1500);
  check("a person who is not a member cannot watch", !outsider.opened && outsider.frames.length === 0, outsider.failed);
  r = await call("GET", `/v1/monorepos/${t.full}/agents/1/live`, t.secret);
  check("without Upgrade: 426", r.status === 426, r.status);
} catch (error) {
  check("the run reached its end", false, scrub(error.stack ?? error));
} finally {
  const r = await call("DELETE", `/v1/monorepos/${t.full}?confirm=${t.full}`, t.secret);
  check(`cleanup: ${t.full} is deleted`, r.status === 204, r.status);
}

done();
