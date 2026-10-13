// End to end, stage 1: one agent session in pando-agents, on the scripted
// model, with Pi's tools in a real container whose workspace is the
// session's branch, mounted through pando and ArtifactFS. Real git and real
// Artifacts through Pando's Worker, real D1 and Durable Objects.
//
//   agents/test/serve.sh start
//   node agents/test/session.mjs                   the run
//   agents/test/serve.sh restart
//   node agents/test/session.mjs --after-restart   the same session after a full restart
//   agents/test/serve.sh stop
//
// AGENTS_URL (http://127.0.0.1:8863). It deletes the repository it made at
// the end of --after-restart (or at once when the first part fails). No
// secret is printed.

import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { agents, call, check, done, git, makeRepo, say, scrub, tool } from "./lib.mjs";

const STATE = process.env.AGENTS_STATE ? `${process.env.AGENTS_STATE}/session-test.json` : new URL("../.state/session-test.json", import.meta.url);

const after = process.argv.includes("--after-restart");

const lastText = (transcript) => {
  const m = transcript.findLast((x) => x.role === "assistant");

  return m?.parts.filter((p) => p.type === "text").map((p) => p.text).join("") ?? "";
};

async function cleanup(t) {
  await agents("stop", { monorepo: t.monorepoId, session: t.sessionId }).catch(() => {});
  const r = await call("DELETE", `/v1/monorepos/${t.full}?confirm=${t.full}`, t.secret);
  check(`cleanup: the repository ${t.full} is deleted`, r.status === 204, r.status);
}

if (!after) {
  const t = await makeRepo("agents-s1", { "README.md": "# Agents\n\nThis line has a tpyo.\n", "src/app.js": "export const answer = 41;\n" });

  try {
    // A web hook on this machine: the agent's push comes in through the gateway (http://pando.internal),
    // and the payload must carry the public address (PUBLIC_ORIGIN; PANDO_PUBLIC_ORIGIN when the server runs with another).
    const hooked = [];

    const receiver = createServer((req, res) => {
      let body = "";

      req.on("data", (c) => (body += c));
      req.on("end", () => {
        hooked.push(JSON.parse(body));
        res.end("ok");
      });
    }).listen(0, "127.0.0.1");

    receiver.unref();
    await new Promise((ok) => receiver.once("listening", ok));
    let r = await call("POST", `/v1/monorepos/${t.full}/repos/${t.name}/hooks`, t.secret, { type: "web", url: `http://127.0.0.1:${receiver.address().port}/hook`, secret: "s", events: ["push"] });
    check("a web hook on the repository", r.status === 201, r.status);

    r = await call("POST", "/v1/user/credentials", t.secret, { name: "cloud-1", kind: "sandbox" });
    check("a sandbox credential for the session", r.status === 201, r.status);

    const spec = {
      number: 1,
      kind: "task",
      monorepo: { id: t.monorepoId, full: t.full, kind: "repo" },
      repo: { name: t.name, path: "." },
      branch: "agent/1-readme",
      model: "scripted",
      launcher: { login: t.login, name: "Agent Tester", email: "tester@pando.invalid" },
      credential: { id: r.json.id, name: "cloud-1", secret: r.json.secret },
      issue: null,
    };

    Object.assign(t, { sessionId: spec.number });
    writeFileSync(STATE, JSON.stringify({ ...t }));

    const prompt = [
      "Fix the typo in the README and push the branch.",
      tool("bash", { command: "pwd; git branch --show-current; findmnt -no FSTYPE . || echo not-a-mount" }),
      tool("edit", { path: "README.md", edits: [{ oldText: "tpyo", newText: "typo" }] }),
      tool("bash", { command: "git commit -qam 'Fix the README typo' && git push -q origin agent/1-readme 2>&1; echo pushed=$?" }),
      tool("write", { path: "notes/plan.md", content: "kept in the workspace\n" }),
      tool("read", { path: "README.md" }),
    ].join("\n");

    let t0 = Date.now();
    let st = await agents("start", { spec, prompt });
    check("start: the session is working", st.status === "working", JSON.stringify(st));
    st = await agents("settled", { monorepo: t.monorepoId, session: spec.number });
    check("the run ends and waits for a person", st.status === "waiting", `${Date.now() - t0} ms, first run includes the container start\n${JSON.stringify(st)}`);
    check("the workspace is the branch, mounted through ArtifactFS", st.workspace === "mount", st.workspace);

    let tr = await agents("transcript", { monorepo: t.monorepoId, session: spec.number });
    const results = tr.filter((m) => m.role === "tool").map((m) => m.parts[0]);
    say(`      tools: ${results.map((p) => `${p.name}${p.error ? " (error)" : ""}`).join(", ")}`);
    check("five tool calls, none failed", results.length === 5 && results.every((p) => !p.error), results.map((p) => p.text.slice(0, 200)).join("\n"));
    check("bash ran in the branch's worktree, a FUSE mount", /\/workspace\/repo\/worktrees\/agent-1-readme\nagent\/1-readme\nfuse\.artifact-fs/.test(results[0]?.text ?? ""), results[0]?.text);
    check("edit, commit and push", /pushed=0/.test(results[2]?.text ?? ""), results[2]?.text);
    const PUBLIC = (process.env.PANDO_PUBLIC_ORIGIN ?? "https://app.gitpando.com").replace(/\/$/, "");
    const until = Date.now() + 30_000;

    while (!hooked.some((h) => h.branch === "agent/1-readme") && Date.now() < until) await new Promise((ok) => setTimeout(ok, 250));
    const pushed = hooked.find((h) => h.branch === "agent/1-readme") ?? {};
    check("the push's hook sends the public clone and status URLs, never pando.internal",
      pushed.clone_url === `${PUBLIC}/${t.full}.git` && (pushed.status_url ?? "").startsWith(`${PUBLIC}/v1/monorepos/${t.full}/repos/${t.name}/statuses/`), `${pushed.clone_url} ${pushed.status_url}`);
    check("the model's answer carries what read returned", /This line has a typo\./.test(lastText(tr)), lastText(tr).slice(0, 300));

    r = await call("GET", `/v1/monorepos/${t.full}/repos/${t.name}/branches`, t.secret);
    check("Pando lists the agent's branch", JSON.stringify(r.json).includes("agent/1-readme"));
    r = await call("GET", `/v1/monorepos/${t.full}/machines`, t.secret);
    check("the Machines tab shows the session's credential, cloud-1", JSON.stringify(r.json).includes("cloud-1"));
    const sh = join(t.work, "check");
    const g = git(["clone", "-q", "-b", "agent/1-readme", t.cloneUrl, sh], t.work, t.secret);
    const log = git(["log", "-1", "--format=%an <%ae>%n%(trailers:only)"], sh);
    check("the commit is authored as the person, with Pando's trailers", g.ok && /Agent Tester <tester@pando\.invalid>/.test(log.out) && /Pando-Machine: cloud-1/.test(log.out), log.out);

    st = await agents("send", { monorepo: t.monorepoId, session: spec.number, prompt: [
      "Check what the sandbox can reach.",
      tool("bash", { command: "curl -s -o /dev/null -w 'api=%{http_code}\\n' http://pando.internal/v1/user; git ls-remote http://pando.internal/someone/else.git 2>&1 | tail -1; curl -s -m 5 -o /dev/null https://example.com && echo internet || echo no-internet; (env; git config --list --show-origin) | grep -c 'pando_' || true" }),
    ].join("\n") });
    st = await agents("settled", { monorepo: t.monorepoId, session: spec.number });
    tr = await agents("transcript", { monorepo: t.monorepoId, session: spec.number });
    const reach = tr.filter((m) => m.role === "tool").at(-1)?.parts[0]?.text ?? "";
    check("the gateway refuses the API and other repositories; no internet; no credential inside", /api=403/.test(reach) && /403/.test(reach.split("\n")[1] ?? "") && /no-internet/.test(reach) && /\n0\n?$/.test(reach.trim() + "\n"), reach);
    writeFileSync(STATE, JSON.stringify({ ...t, prompts: 2 }));
    say("\nNow restart the server (agents/test/serve.sh restart) and run with --after-restart.");
  } catch (error) {
    say(`FAIL  ${scrub(error.stack ?? error)}`);
    check("the first part ran to the end", false);
    await cleanup(t);
  }
} else {
  const t = JSON.parse(readFileSync(STATE, "utf8"));

  try {
    let st = await agents("state", { monorepo: t.monorepoId, session: t.sessionId });
    check("after a full restart the session is still there, waiting", st.status === "waiting", JSON.stringify(st));
    st = await agents("send", { monorepo: t.monorepoId, session: t.sessionId, prompt: "recall" });
    st = await agents("settled", { monorepo: t.monorepoId, session: t.sessionId });
    const tr = await agents("transcript", { monorepo: t.monorepoId, session: t.sessionId });
    check("the model is given every earlier prompt from the object's storage", /I see 2 earlier prompts/.test(lastText(tr)), lastText(tr).slice(0, 300));
    st = await agents("send", { monorepo: t.monorepoId, session: t.sessionId, prompt: tool("bash", { command: "cat notes/plan.md; git log --oneline -1" }) });
    st = await agents("settled", { monorepo: t.monorepoId, session: t.sessionId });
    const last = (await agents("transcript", { monorepo: t.monorepoId, session: t.sessionId })).filter((m) => m.role === "tool").at(-1)?.parts[0]?.text ?? "";
    check("the sandbox carries on in the same branch", /Fix the README typo/.test(last), `${st.sandbox}\n${last}`);
    st = await agents("stop", { monorepo: t.monorepoId, session: t.sessionId });
    check("Stop: the session is stopped and its sandbox gone", st.status === "stopped" && st.sandbox === "stopped", JSON.stringify(st));
  } finally {
    await cleanup(t);
  }
}

done();
