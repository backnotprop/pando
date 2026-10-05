// End to end, stage 8: the repository assistant. A chat answers from Pando's
// read tools with no sandbox: no container starts. It is its person's alone.
// Asked for a change, it starts its own branch (start_branch), works in a
// sandbox, and merges. One session per chat, per person.
//
//   agents/test/serve.sh start && node agents/test/assistant.mjs

import { BOOT, call, check, done, makeRepo, scrub, tool, untilSettled } from "./lib.mjs";

const toolsOf = async (t, n, secret = t.secret) => (await call("GET", `/v1/monorepos/${t.full}/agents/${n}/transcript`, secret)).json.messages.filter((m) => m.role === "tool").map((m) => m.parts[0]);

const t = await makeRepo("agents-s8", { "README.md": "# Assistant\n", "src/app.js": "export const answer = 42;\n" });

try {
  // ── A question ──
  let r = await call("POST", `/v1/monorepos/${t.full}/assistant`, t.secret, {
    model: "scripted",
    prompt: ["What does src/app.js export?", tool("list_files", { path: "src" }), tool("read_file", { path: "src/app.js" }), tool("bash", { command: "ls" })].join("\n"),
  });

  check("a new chat: 201, kind chat, its branch assistant/1 named but not made", r.status === 201 && r.json?.kind === "chat" && r.json?.branch === "assistant/1", scrub(JSON.stringify(r.json)));
  r = await untilSettled(t, 1);
  check("it answers and waits, with no sandbox started", r.json?.status === "waiting" && r.json?.workspace === null, JSON.stringify(r.json));
  let res = await toolsOf(t, 1);
  check("list_files and read_file answer from the server", /^app\.js$/m.test(res[0]?.text ?? "") && /export const answer = 42;/.test(res[1]?.text ?? ""), `${res[0]?.text}\n${res[1]?.text}`);
  check("bash is not offered before start_branch", res[2]?.name === "bash" && res[2]?.error === true, res[2]?.text);
  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches`, t.secret);
  check("no branch was made for a question", !JSON.stringify(r.json).includes("assistant/1"));

  // ── Its person's alone ──
  r = await call("GET", `/v1/monorepos/${t.full}/assistant`, t.secret);
  check("GET .../assistant lists the person's chat", r.json?.sessions?.length === 1 && r.json.sessions[0].number === 1);
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

  // ── A change ──
  r = await call("POST", `/v1/monorepos/${t.full}/agents/1/messages`, t.secret, {
    prompt: [
      "Add a line to the README and merge it.",
      tool("start_branch", {}),
      tool("bash", { command: "git branch --show-current && echo 'Changed by the assistant.' >> README.md && git commit -qam 'A line from the assistant' && git push -q origin assistant/1 2>&1; echo pushed=$?" }),
      tool("merge", {}),
    ].join("\n"),
  });
  r = await untilSettled(t, 1);
  check("the change runs, now with a sandbox on its branch", r.json?.status === "waiting" && r.json?.workspace === "mount", JSON.stringify(r.json));
  res = await toolsOf(t, 1);
  const [start, bash, merge] = res.slice(-3);
  check("start_branch, then bash on assistant/1, then merge", start?.name === "start_branch" && !start.error && /^assistant\/1$/m.test(bash?.text ?? "") && /pushed=0/.test(bash?.text ?? "") && merge?.name === "merge" && !merge.error, res.slice(-3).map((p) => `${p.name}: ${p.text.slice(0, 120)}`).join("\n"));
  r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/files/README.md`, t.secret);
  check("main has the change", /Changed by the assistant\./.test(r.text), r.text);

  // ── One session per chat ──
  r = await call("POST", `/v1/monorepos/${t.full}/assistant`, t.secret, { model: "scripted", prompt: "A new question." });
  check("a second chat is its own session, assistant/2", r.status === 201 && r.json?.number === 2 && r.json?.branch === "assistant/2");
  await untilSettled(t, 2);
  r = await call("GET", `/v1/monorepos/${t.full}/assistant`, t.secret);
  check("the person's chats, newest first", r.json?.sessions?.map((s) => s.number).join(",") === "2,1");
} catch (error) {
  check("the run reached its end", false, scrub(error.stack ?? error));
} finally {
  const r = await call("DELETE", `/v1/monorepos/${t.full}?confirm=${t.full}`, t.secret);
  check(`cleanup: ${t.full} is deleted`, r.status === 204, r.status);
}

done();
