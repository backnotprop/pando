// End to end: an agent's sandbox keeps the shared files live (pando sync,
// agents/container/sync.sh). A monorepo with projects/app; the person is a
// machine on its shared files' socket, as pando sync is on any machine.
//
// - The sandbox starts pando sync once, and is a connected machine.
// - The person's save reaches the sandbox within seconds, and the agent's
//   note comes back the same way (a round trip, timed on the person's side).
// - A note the agent writes with its write tool reaches the person with
//   the agent's machine and the person's name, and becomes a commit in
//   meta.git after the quiet period.
// - A binary file the agent makes goes up as a large file.
// - A save in the run's last moment, with the live sync stopped, still
//   reaches Pando before the run ends (the session's flush).
// - After Stop and a start from the snapshot, pando sync runs again and
//   catches up.
// - A conflict: the agent's edit loses to the person's save; the sandbox
//   keeps a conflict copy and the bash result says so.
//
//   agents/test/serve.sh start && node agents/test/sync.mjs

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, BOOT, call, check, done, git, say, scrub, sleep, tool, untilSettled } from "./lib.mjs";

const id = Date.now().toString(36);

const login = `agents-sync-${id}`;

const name = `agents-sync-${id}`;

const full = `${login}/${name}`;

const base = `/v1/monorepos/${full}`;

const ROOT = "/workspace/repo";

const blobSha = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

async function until(pred, ms) {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await pred();

    if (v) return v;
    await sleep(100);
  }

  return null;
}

let r = await call("POST", "/v1/users", BOOT, { login, name: "Sync Tester", email: "sync-tester@pando.invalid", credential_name: "tester-mbp" });

const secret = r.json?.credential?.secret;

check("a person with a machine credential", r.status === 201 && secret?.startsWith("pando_"), r.status);

r = await call("POST", "/v1/monorepos", secret, { name, kind: "monorepo" });

check("a monorepo", r.status === 201, r.status);

const frames = [];

/** Each shared file's newest version the person knows. */
const versions = {};

let ws;

const toolResults = async () => (await call("GET", `${base}/agents/1/transcript`, secret)).json.messages.filter((m) => m.role === "tool");

const lastTool = async () => (await toolResults()).at(-1)?.parts[0]?.text ?? "";

/** Sends the agent a message; the answer waits for that run's end (a new tool result, then waiting) and gives its last tool result. */
async function message(prompt) {
  const before = (await toolResults()).length;
  await call("POST", `${base}/agents/1/messages`, secret, { prompt });

  return async () => {
    const out = await until(async () => {
      const status = (await call("GET", `${base}/agents/1`, secret)).json?.status;
      const list = status === "waiting" || status === "failed" ? await toolResults() : [];

      return list.length > before ? (list.at(-1).parts[0]?.text ?? "") : null;
    }, 240_000);

    return out ?? "(the run did not end)";
  };
}

/** Whether cloud-1 is on the shared files' socket now. */
const online = async () => JSON.stringify((await call("GET", `${base}/meta/status`, secret)).json?.connections ?? "").includes("cloud-1");

/** The person's save over the socket: the answer frame. */
async function save(path, text) {
  const bytes = Buffer.from(text);
  const sid = `p-${path}-${Date.now()}`;
  ws.send(JSON.stringify({ type: "save", id: sid, path, base_version: versions[path] ?? 0, sha: blobSha(bytes), bytes: bytes.toString("base64") }));

  return until(() => frames.find((f) => f.id === sid && f.type !== "change"), 10_000);
}

const changeOf = (path, text) => frames.find((f) => f.type === "change" && f.path === path && (text === undefined || Buffer.from(f.bytes ?? "", "base64").toString() === text));

try {
  r = await call("POST", `${base}/repos`, secret, { path: "projects/app" });
  const cloneUrl = r.json?.clone_url;
  check("projects/app", r.status === 201 && r.json?.name === "projects-app", r.status);
  const src = mkdtempSync(join(tmpdir(), "pando-agents-sync-"));
  git(["init", "-q"], src);
  git(["commit", "-q", "--allow-empty", "-m", "first"], src);
  check("its main pushed", git(["push", "-q", cloneUrl, "main"], src, secret).ok);

  // ── The person, live on the shared files ──
  ws = new WebSocket(`${BASE.replace(/^http/, "ws")}${base}/meta/socket`, { headers: { authorization: `Bearer ${secret}` } });
  ws.onmessage = (m) => {
    if (m.data === "pong") return;
    const f = JSON.parse(m.data);
    frames.push(f);

    if ((f.type === "change" || f.type === "accepted") && f.path) versions[f.path] = f.version;
  };

  ws.onerror = () => {};

  await until(() => ws.readyState === 1, 10_000);
  ws.send(JSON.stringify({ type: "hello", since: 0, machine: "tester-mbp", client: "agents-sync-test/1" }));
  check("the person is live on the shared files", !!(await until(() => frames.find((f) => f.type === "caught_up"), 10_000)));
  r = await save("plans/plan.md", "v1\n");
  check("the person saves plans/plan.md", r?.type === "accepted", JSON.stringify(r));

  // ── Launch: the sandbox runs pando sync ──
  r = await call("POST", `${base}/agents`, secret, {
    prompt: ["Read the plan.", tool("bash", { command: `cat ${ROOT}/plans/plan.md; echo "daemons=$(pgrep -fc '(^|[ /])pando sync$')"; tail -3 /workspace/pando-sync.log` })].join("\n"),
    model: "scripted",
    repo: "projects-app",
    branch: "notes",
  });
  check("launched on projects/app", r.status === 201, scrub(JSON.stringify(r.json)));
  r = await untilSettled({ full, secret }, 1);
  check("the run ends, waiting", r.json?.status === "waiting", JSON.stringify(r.json));
  let out = await lastTool();
  check("the sandbox has the shared files, and one pando sync runs", /^v1$/m.test(out) && /daemons=1/.test(out), out);
  // At the run's end the session sends what waits (pando sync --once) and starts the live sync again: back within seconds.
  check("the sandbox is on the shared files' socket as cloud-1", !!(await until(online, 10_000)));
  const machine = await until(async () => (await call("GET", `${base}/machines`, secret)).json?.machines?.find((m) => m.name === "cloud-1" && m.connected), 10_000);
  check("Machines shows cloud-1 connected, a sandbox", machine?.connected === true && machine?.kind === "sandbox", scrub(JSON.stringify(machine)));

  // ── Live both ways: a round trip timed on the person's side ──
  const wait = `for i in $(seq 1 300); do grep -q v2 ${ROOT}/plans/plan.md && break; sleep 0.05; done`;
  let ran = await message(tool("bash", { command: `mkdir -p ${ROOT}/notes && echo ready > ${ROOT}/notes/ready.md; ${wait}; cat ${ROOT}/plans/plan.md; echo seen > ${ROOT}/notes/seen.md` }));
  const ready = await until(() => changeOf("notes/ready.md", "ready\n"), 60_000);
  check("the agent's file reaches the person, from cloud-1", ready?.machine === "cloud-1", JSON.stringify(ready && { machine: ready.machine, author: ready.author }));
  const t0 = Date.now();
  r = await save("plans/plan.md", "v2\n");
  const seen = await until(() => changeOf("notes/seen.md", "seen\n"), 20_000);
  const trip = Date.now() - t0;
  check("the person's save reaches the sandbox and the agent's answer comes back within 5 s", !!seen && trip < 5_000, `${trip} ms for the round trip`);
  say(`      round trip: ${trip} ms (person's save, the sandbox sees it, the agent's note back)`);
  out = await ran();
  check("the sandbox read v2", /^v2$/m.test(out), out);

  // ── The agent's note through its write tool becomes a commit ──
  ran = await message(tool("write", { path: `${ROOT}/notes/agent-note.md`, content: "The agent's note.\n" }));
  const note = await until(() => changeOf("notes/agent-note.md", "The agent's note.\n"), 60_000);
  check("the note written with the write tool reaches the person, as the person from cloud-1", note?.machine === "cloud-1" && /Sync Tester/.test(note?.author ?? ""), JSON.stringify(note && { machine: note.machine, author: note.author }));
  await ran();

  const committed = await until(async () => {
    const h = (await call("GET", `${base}/meta/history?path=notes/agent-note.md`, secret)).json;

    return h?.versions?.[0]?.commit ? h.versions[0] : null;
  }, 40_000);

  check("after the quiet period it is a commit in meta.git", !!committed, JSON.stringify(committed));
  const metaUrl = (await call("GET", `${base}/repos/meta`, secret)).json?.clone_url;
  const meta = mkdtempSync(join(tmpdir(), "pando-agents-sync-meta-"));
  git(["init", "-q"], meta);
  git(["fetch", "-q", metaUrl, "main"], meta, secret);
  const shown = git(["show", "FETCH_HEAD:notes/agent-note.md"], meta);
  const author = git(["log", "-1", "--format=%an", "FETCH_HEAD", "--", "notes/agent-note.md"], meta);
  check("meta.git's main holds the note, authored by the person", shown.out === "The agent's note.\n" && author.out.trim() === "Sync Tester", `${shown.out.trim()} / ${author.out.trim()}`);

  // ── A binary file goes up as a large file (its bytes to R2 through the gateway, a pointer live) ──
  await (await message(tool("bash", { command: `head -c 4096 /dev/urandom > ${ROOT}/notes/shot.bin; echo made` })))();
  const large = await until(async () => (await call("GET", `${base}/meta/history?path=notes/shot.bin`, secret)).json?.versions?.[0]?.large, 20_000);
  check("a binary file the agent makes is saved as a large file", large?.size === 4096, JSON.stringify(large));

  // ── A save in the run's last moment, with the live sync stopped, is sent before the run ends ──
  out = await (await message(tool("bash", { command: `pkill -STOP -f '(^|[ /])pando sync$'; echo last > ${ROOT}/notes/last.md; echo written` })))();
  r = await call("GET", `${base}/meta/file?path=notes/last.md`, secret);
  check("its save is on Pando when the run ends (the session flushes the sync)", r.status === 200 && r.text === "last\n", `${r.status} ${r.text}`);

  // ── Stop, a save while stopped, then a start from the snapshot ──
  r = await call("POST", `${base}/agents/1/stop`, secret);
  check("Stop: its sandbox is saved and stopped", r.json?.status === "stopped", JSON.stringify(r.json));
  r = await save("plans/plan.md", "v3, while the agent was stopped\n");
  check("the person saves while the sandbox is stopped", r?.type === "accepted", JSON.stringify(r));
  out = await (await message(tool("bash", { command: `for i in $(seq 1 200); do grep -q v3 ${ROOT}/plans/plan.md && break; sleep 0.05; done; cat ${ROOT}/plans/plan.md; echo "daemons=$(pgrep -fc '(^|[ /])pando sync$')"; echo restored > ${ROOT}/notes/restored.md` })))();
  check("after the start from the snapshot, one pando sync runs and has the save made meanwhile", /^v3, while the agent was stopped$/m.test(out) && /daemons=1/.test(out), out);
  check("and the agent's next note reaches the person", !!(await until(() => changeOf("notes/restored.md", "restored\n"), 20_000)));

  // ── A conflict: the agent's edit loses to the person's save ──
  // The sandbox's sync stops; the agent edits the plan; the person saves it
  // first; the sync starts again and its save is answered stale.
  const fileOnPando = `curl -s "http://pando.internal${base}/meta/file?path=plans/plan.md"`;

  const conflictCmd = [
    `pkill -TERM -f '(^|[ /])pando sync$'; while pgrep -f '(^|[ /])pando sync$' >/dev/null; do sleep 0.1; done`,
    `echo "the agent's plan" > ${ROOT}/plans/plan.md`,
    `for i in $(seq 1 300); do ${fileOnPando} | grep -q "person's plan" && break; sleep 0.1; done`,
    "pando-agent-sync start 2>/dev/null",
    "for i in $(seq 1 150); do grep -q 'conflict on plans/plan.md' /workspace/pando-sync.log && break; sleep 0.1; done",
    `cat ${ROOT}/plans/plan.md ${ROOT}/plans/plan.conflict-local-*.md`,
  ].join("\n");

  check("the sandbox's sync is back on the socket after the last run", !!(await until(online, 10_000)));
  ran = await message(tool("bash", { command: conflictCmd }));
  const gone = await until(async () => !(await online()), 60_000);
  check("the sandbox's sync stops (off the socket)", !!gone);
  r = await save("plans/plan.md", "the person's plan\n");
  check("the person saves the plan first", r?.type === "accepted", JSON.stringify(r));
  out = await ran();
  check("the bash result says the shared file has a conflict copy", /^\[Pando\] shared file plans\/plan\.md has a conflict copy: .*Your version is in plans\/plan\.conflict-local-\d{8}T\d{6}Z\.md\. plans\/plan\.md is frozen until: pando resolve plans\/plan\.md$/m.test(out), out);
  check("the sandbox holds the person's plan, and the agent's in the copy", /^the person's plan\nthe agent's plan$/m.test(out), out);
  r = await call("GET", `${base}/meta/file?path=plans/plan.md`, secret);
  check("Pando keeps the person's plan", r.text === "the person's plan\n", r.text);
  out = await (await message(tool("bash", { command: "echo again" })))();
  check("the line is said once, not after every command", out.trim() === "again", out);
} catch (error) {
  check("the run reached its end", false, scrub(error.stack ?? error));
} finally {
  ws?.close();
  await call("POST", `${base}/agents/1/stop`, secret).catch(() => {});
  const d = await call("DELETE", `${base}?confirm=${full}`, secret);
  check(`cleanup: ${full} is deleted`, d.status === 204, d.status);
}

done();
