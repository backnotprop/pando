// End to end, stage 6: Continue. A session's sandbox is saved after each run
// and at Stop (a container snapshot). A message after Stop brings the sandbox
// back from that snapshot: the files as they were, unpushed changes and an
// unpushed commit included, no processes; the agent is told so in one line;
// the transcript is whole, and it carries on and pushes.
//
//   agents/test/serve.sh start && node agents/test/continue.mjs

import { call, check, done, makeRepo, scrub, tool, untilSettled } from "./lib.mjs";

const results = async (t, n) => (await call("GET", `/v1/monorepos/${t.full}/agents/${n}/transcript`, t.secret)).json.messages;

const t = await makeRepo("agents-s6", { "README.md": "# Continue\n" });

try {
  const prompt = [
    "Start, push one change, and leave some work unpushed.",
    tool("bash", { command: "echo pushed > pushed.txt && git add pushed.txt && git commit -qm 'Pushed change' && git push -q origin keep-work 2>&1; echo pushed=$?" }),
    tool("bash", { command: "echo local > local-commit.txt && git add local-commit.txt && git commit -qm 'Committed, not pushed' && echo 'not committed' > notes.txt && (sleep 1000 >/dev/null 2>&1 & echo $! > /root/background.pid) ; echo done" }),
  ].join("\n");

  let r = await call("POST", `/v1/monorepos/${t.full}/agents`, t.secret, { prompt, model: "scripted", branch: "keep-work" });
  check("launched", r.status === 201, r.status);
  r = await untilSettled(t, 1);
  check("the first run ends", r.json?.status === "waiting", JSON.stringify(r.json));

  r = await call("POST", `/v1/monorepos/${t.full}/agents/1/stop`, t.secret);
  check("Stop: stopped, its sandbox saved and stopped", r.json?.status === "stopped", JSON.stringify(r.json));

  // ── Continue ──
  const t0 = Date.now();
  r = await call("POST", `/v1/monorepos/${t.full}/agents/1/messages`, t.secret, {
    prompt: tool("bash", { command: "cat notes.txt; git log --format=%s -2; kill -0 $(cat /root/background.pid) 2>/dev/null && echo still-running || echo no-processes" }),
  });
  check("a message after Stop: working again", r.status === 200 && r.json?.status === "working", JSON.stringify(r.json));
  r = await untilSettled(t, 1);
  check("and it ends, waiting", r.json?.status === "waiting", `${Date.now() - t0} ms, including the start from the snapshot`);

  const msgs = await results(t, 1);
  const told = msgs.filter((m) => m.role === "user").at(-1)?.parts[0]?.text ?? "";
  check("the agent is told its sandbox comes back from a snapshot", /^\[Pando\] Your sandbox stopped since your last message\. On your next command it comes back from a snapshot of its files taken at \d{4}-\d\d-\d\dT/.test(told), told.split("\n")[0]);
  const out = msgs.filter((m) => m.role === "tool").at(-1)?.parts[0]?.text ?? "";
  check("the uncommitted edit is back", /not committed/.test(out), out);
  check("the unpushed commit is back, on top of the pushed one", /Committed, not pushed\nPushed change/.test(out), out);
  check("no processes came back", /no-processes/.test(out), out);
  check("the transcript is whole: both prompts and the message", msgs.filter((m) => m.role === "user").length === 2 && msgs.filter((m) => m.role === "tool").length === 3);

  r = await call("POST", `/v1/monorepos/${t.full}/agents/1/messages`, t.secret, { prompt: tool("bash", { command: "git push -q origin keep-work 2>&1; echo pushed=$?" }) });
  await untilSettled(t, 1);
  const pushed = (await results(t, 1)).filter((m) => m.role === "tool").at(-1)?.parts[0]?.text ?? "";
  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches/keep-work/commits`, t.secret);
  check("it carries on: the restored commit is pushed", /pushed=0/.test(pushed) && JSON.stringify(r.json).includes("Committed, not pushed"), pushed);
} catch (error) {
  check("the run reached its end", false, scrub(error.stack ?? error));
} finally {
  const r = await call("DELETE", `/v1/monorepos/${t.full}?confirm=${t.full}`, t.secret);
  check(`cleanup: ${t.full} is deleted`, r.status === 204, r.status);
}

done();
