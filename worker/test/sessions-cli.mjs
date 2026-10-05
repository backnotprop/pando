// Agent sessions from the machine, end to end (stage 2): the real pando binary (go build), `pando sync` reading agent
// stores under the test's own HOME (a Pi session file and an OpenCode V2 database, both from the recorded fixtures),
// the commit hook in a real worktree run by stand-in agent programs, and wrangler dev with its local D1, Durable
// Objects and R2.
//
//   PANDO_URL=http://localhost:8869 node test/sessions-cli.mjs
//
// Every pando and git run has HOME, PANDO_HOME and every agent's data-folder variable pointed into the test's folder,
// so nothing of this machine's own agents is read. Credentials are never printed. It deletes its monorepo.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describeError, retryResetFetch, throwaways } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8869").replace(/\/$/, "");

const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>");

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`));
};

// The contract's recordings of the person's session settings (packages/contract/recorded, checked by check-recorded.ts).
const record = (file, schema, route, r) => writeFileSync(new URL(`../../packages/contract/recorded/${file}`, import.meta.url), `${scrub(JSON.stringify({ schema, route, status: r.status, body: r.json }, null, 2))}\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = (method, path, secret, body) => request(URL_, method, path, { secret, body, headers: { connection: "close" } });

const waitFor = async (pred, ms = 30_000) => {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await pred();

    if (v) return v;
    await sleep(300);
  }

  return null;
};

const fixture = (name) => readFileSync(new URL(`./sessions/fixtures/${name}`, import.meta.url), "utf8");

function sessionId(program, agentId) {
  let n = BigInt(`0x${createHash("sha256").update(`${program}:${agentId}`).digest("hex").slice(0, 32)}`);
  let out = "";

  for (let i = 0; i < 26; i++) {
    out = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number(n & 31n)] + out;
    n >>= 5n;
  }

  return `s_${out}`;
}

/** Every recorded time in a line moved by `ms`, so a fixture reads as recorded now. */
function shift(line, ms) {
  const keys = new Set(["timestamp", "time_created", "created", "completed", "streamed", "ran", "start", "end"]);

  return JSON.stringify(JSON.parse(line, (k, v) => {
    if (!keys.has(k)) return v;

    if (Number.isSafeInteger(v) && v > 1e11) return v + ms;

    return /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(Date.parse(v) + ms).toISOString() : v;
  }));
}

const id = Date.now().toString(36);

const work = mkdtempSync(join(tmpdir(), "pando-scli-"));

const HOME = join(work, "home");

mkdirSync(HOME);

// Every agent's data-folder variable cleared: only the stores under the test's HOME are read.
const SAFE = {
  HOME, XDG_CONFIG_HOME: join(HOME, ".config"), XDG_DATA_HOME: "", PANDO_HOME: join(work, "pando-home"),
  CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", PI_CODING_AGENT_DIR: "", PI_CODING_AGENT_SESSION_DIR: "", OPENCODE_DB: "",
  CLAUDE_CODE_SESSION_ID: "", CODEX_THREAD_ID: "", PI_SESSION_ID: "", OPENCODE_SESSION_ID: "",
  GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", PANDO_SERVER: "", PANDO_TOKEN: "", PANDO_AGENT: "", PANDO_NO_BROWSER: "1",
  PANDO_MACHINE: "scli-box", PANDO_WORKTREE_KIND: "sparse", PANDO_SESSIONS_EVERY: "300ms",
  GIT_AUTHOR_NAME: "Ana", GIT_AUTHOR_EMAIL: "ana@pando.invalid", GIT_COMMITTER_NAME: "Ana", GIT_COMMITTER_EMAIL: "ana@pando.invalid",
};

const bin = join(work, "pando");

const pando = (args, o = {}) =>
  new Promise((resolve) => {
    const child = spawn(o.exe ?? bin, args, { cwd: o.cwd ?? work, env: { ...process.env, ...SAFE, ...o.env } });
    const out = { status: null, stdout: "", stderr: "" };
    child.stdout.on("data", (d) => (out.stdout += d));
    child.stderr.on("data", (d) => (out.stderr += d));
    child.on("close", (code) => resolve({ ...out, status: code }));
    child.on("error", (err) => resolve({ ...out, status: -1, stderr: out.stderr + String(err.message) }));
    child.stdin.end(o.input ?? "");
  });

const git = (args, cwd, env = {}) => spawnSync("git", ["-c", "credential.helper=", "-c", "init.defaultBranch=main", ...args], { cwd, env: { ...process.env, ...SAFE, ...env }, encoding: "utf8" });

// Stand-in agent programs: a script named like the agent runs the command it is given, as an agent runs git in its
// shell. The hook walks up the processes and finds it by name.
const agents = join(work, "agents");

mkdirSync(agents);

for (const name of ["codex", "claude"]) {
  writeFileSync(join(agents, name), '#!/bin/sh\n"$@"\n');
  chmodSync(join(agents, name), 0o755);
}

const as = (agent, env, args, cwd) => spawnSync(join(agents, agent), args, { cwd, env: { ...process.env, ...SAFE, ...env }, encoding: "utf8" });

const said = (run) => scrub(`${run.status} ${run.stdout} ${run.stderr}`).trim().slice(0, 300);

const LOGIN = `scli-${id}`;

const NAME = `scli-${id}`;

const full = `${LOGIN}/${NAME}`;

let S = null;

let sync = null;

const tw = throwaways(async (f) => (await call("DELETE", `/v1/monorepos/${f}?confirm=${f}`, S)).status);

const startSync = (mono) => {
  const child = spawn(bin, ["sync"], { cwd: mono, env: { ...process.env, ...SAFE } });
  const log = { text: "" };
  child.stderr.on("data", (d) => (log.text += d));
  child.stdout.on("data", (d) => (log.text += d));

  return { child, log };
};

const stopSync = async () => {
  if (!sync) return;
  sync.child.kill("SIGTERM");
  await new Promise((r) => sync.child.on("close", r));
  sync = null;
};

try {
  S = (await call("POST", "/v1/users", BOOT, { login: LOGIN, credential_name: "scli-box" })).json?.credential?.secret;
  const cli = fileURLToPath(new URL("../../cli", import.meta.url));
  const built = spawnSync("go", ["build", "-buildvcs=false", "-o", bin, "./cmd/pando"], { cwd: cli, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  check("the cli builds", built.status === 0, built.stderr?.slice(0, 200));
  let r = await pando(["login", "--server", URL_, "--with-credential"], { input: S + "\n" });
  check("pando login (piped: recording is not asked)", r.status === 0 && !/Record agent sessions/.test(r.stderr), said(r));
  // At a terminal (a pty, from Python's pty module), login asks once; once answered, never again. The credential is
  // typed only after pando turned echo off for it.
  const PTY = `import os, pty, sys, select, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
out, sent_secret, sent_answer = b"", False, False
while True:
    r, _, _ = select.select([fd], [], [], 20)
    if not r: break
    try: chunk = os.read(fd, 4096)
    except OSError: break
    if not chunk: break
    out += chunk
    if not sent_secret and b"(input hidden)" in out:
        time.sleep(0.5)  # as a person: after pando turned echo off
        os.write(fd, os.environ["PTY_SECRET"].encode() + b"\\n"); sent_secret = True
    if not sent_answer and b"Record agent sessions" in out:
        os.write(fd, os.environ["PTY_ANSWER"].encode() + b"\\n"); sent_answer = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode(errors="replace"))
sys.exit(os.waitstatus_to_exitcode(status))
`;
  const tty = { PANDO_HOME: join(work, "tty-home"), PTY_SECRET: S, PTY_ANSWER: "n" };
  const term = () => pando(["-c", PTY, bin, "login", "--server", URL_, "--with-credential"], { env: tty, exe: "python3" });
  let t = await term();
  check("at a terminal, the first login asks whether to record", t.status === 0 && /Record agent sessions on this machine/.test(t.stdout), said(t));
  check("the credential typed there is not echoed", !t.stdout.includes(S), "");
  t = await term();
  check("once answered (no), a later login at a terminal never asks again", t.status === 0 && /Signed in/.test(t.stdout) && !/Record agent sessions/.test(t.stdout), said(t));
  check("the answer is kept: recording off", /record = false/.test(readFileSync(join(work, "tty-home", "sessions.toml"), "utf8")), "");

  r = await pando(["login", "--server", URL_, "--with-credential"], { input: S + "\n" });
  check("piped again (as an agent runs it): never asked", r.status === 0 && !/Record agent sessions/.test(r.stdout + r.stderr), said(r));
  r = await pando(["session", "status"]);
  check("recording is off until asked", r.status === 0 && /Recording: off \(never asked/.test(r.stdout), said(r));
  r = await pando(["session", "enable"]);
  check("pando session enable", r.status === 0 && /records agent sessions/.test(r.stdout), said(r));

  // A monorepo with projects/app, and a branch worktree fix-login.
  const mono = join(work, NAME);
  const app = join(mono, "projects", "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(mono, "AGENTS.md"), "notes\n");
  writeFileSync(join(app, "main.go"), "package main\n");
  git(["init", "-q"], app);
  git(["add", "-A"], app);
  git(["commit", "-qm", "first"], app);
  r = await pando(["init", "--yes", "--name", NAME], { cwd: mono });

  if (r.status === 0) tw.add(full);
  check("pando init", r.status === 0, said(r));
  r = await pando(["worktree", "add", "projects/app", "fix-login"], { cwd: mono });
  const wt = join(app, "worktrees", "fix-login");
  check("pando worktree add projects/app fix-login", r.status === 0, said(r));

  // ── The commit hook ──
  const write = (f, text) => writeFileSync(join(wt, f), text);
  const lastMessage = () => git(["log", "-1", "--format=%B"], wt).stdout;
  const lines = () => [...lastMessage().matchAll(/^Pando-Session: (s_\w+)$/gm)].map((m) => m[1]);
  write("a.txt", "1\n");
  git(["add", "-A"], wt);
  git(["commit", "-qm", "typed in a terminal"], wt);
  check("a commit with no agent above it gets no session line", lines().length === 0 && /Pando-Machine/.test(lastMessage()), lastMessage().replace(/\n/g, " | "));
  write("a.txt", "2\n");
  r = as("codex", { CODEX_THREAD_ID: "thread-1" }, ["git", "commit", "-qam", "from codex"], wt);
  check("a commit from Codex's shell names its thread", lines().join() === sessionId("codex", "thread-1"), `${said(r)} ${lines()}`);
  write("a.txt", "3\n");
  r = as("claude", { CLAUDE_CODE_SESSION_ID: "cc-1", CODEX_THREAD_ID: "" }, [join(agents, "codex"), "git", "commit", "-qam", "nested"], wt);
  check("Codex started inside Claude Code, no thread id: no line (Claude's variable is not Codex's)", lines().length === 0, `${lines()}`);
  write("b.txt", "nested\n");
  git(["add", "b.txt"], wt);
  r = as("claude", { CLAUDE_CODE_SESSION_ID: "cc-1", CODEX_THREAD_ID: "thread-2" }, [join(agents, "codex"), "git", "commit", "-qm", "nested"], wt);
  check("Codex inside Claude Code, both variables set: the nearest agent, Codex, names the commit", lines().join() === sessionId("codex", "thread-2"), `${lines()}`);
  const codexCommit = git(["rev-parse", "HEAD"], wt).stdout.trim();
  write("a.txt", "5\n");
  as("claude", { CLAUDE_CODE_SESSION_ID: "cc-1" }, ["git", "commit", "-qam", "from claude"], wt);
  check("a commit from Claude Code's shell names its session", lines().join() === sessionId("claude-code", "cc-1"), `${lines()}`);
  as("claude", { CLAUDE_CODE_SESSION_ID: "cc-1" }, ["git", "commit", "-q", "--amend", "--no-edit"], wt);
  check("an amend by the same session keeps one line", lines().join() === sessionId("claude-code", "cc-1"), `${lines()}`);
  as("claude", { CLAUDE_CODE_SESSION_ID: "cc-2" }, ["git", "commit", "-q", "--amend", "--no-edit"], wt);
  check("an amend by a second session adds its line after the first", lines().join() === [sessionId("claude-code", "cc-1"), sessionId("claude-code", "cc-2")].join(), `${lines()}`);
  as("claude", { CLAUDE_CODE_SESSION_ID: "cc-3" }, ["git", "rebase", "-q", "--onto", "HEAD~2", "HEAD~1"], wt);
  check("a rebase run by another session replays the commit with its lines unchanged", lines().join() === [sessionId("claude-code", "cc-1"), sessionId("claude-code", "cc-2")].join(), `${lines()}`);
  git(["rm", "-q", "b.txt"], wt);
  git(["commit", "-qm", "b.txt goes"], wt);
  r = as("claude", { CLAUDE_CODE_SESSION_ID: "cc-4" }, ["git", "cherry-pick", codexCommit], wt);
  check("a cherry-pick run by another session keeps the picked commit's line only", lines().join() === sessionId("codex", "thread-2"), `${said(r)} ${lines()}`);
  mkdirSync(join(work, "moved-claude", "projects"), { recursive: true });
  write("a.txt", "6\n");
  as("claude", { CLAUDE_CODE_SESSION_ID: "cc-5", CLAUDE_CONFIG_DIR: join(work, "moved-claude") }, ["git", "commit", "-qam", "moved folder"], wt);
  r = await pando(["session", "status"], { cwd: mono });
  check("a moved data folder seen by the hook in Claude Code's shell is read from then on", r.stdout.includes(`${join(work, "moved-claude", "projects")}  (commit hook)`), said(r));
  await pando(["session", "disable"]);
  write("a.txt", "7\n");
  as("codex", { CODEX_THREAD_ID: "thread-9" }, ["git", "commit", "-qam", "recording off"], wt);
  check("with recording off, no line", lines().length === 0, `${lines()}`);
  await pando(["session", "enable"]);

  // ── Stores: a Pi session in the worktree, an OpenCode V2 database with a session in the repository folder ──
  const piLines = fixture("pi.jsonl").split("\n").filter(Boolean);
  const piTimes = piLines.map((l) => Date.parse(JSON.parse(l).timestamp));
  const piShift = Date.now() - 60_000 - Math.max(...piTimes);
  const piHead = JSON.parse(shift(piLines[0], piShift));
  piHead.cwd = wt;
  const piDir = join(HOME, ".pi", "agent", "sessions", "--wt--");
  mkdirSync(piDir, { recursive: true });
  const piFile = join(piDir, "pi-session.jsonl");
  writeFileSync(piFile, [JSON.stringify(piHead), ...piLines.slice(1, 6).map((l) => shift(l, piShift))].join("\n") + "\n");
  const piId = sessionId("pi", piHead.id);

  const ocRaw = fixture("opencode.jsonl").split("\n").filter(Boolean);
  const ocLast = Math.max(...ocRaw.map((l) => JSON.parse(l).time_created));
  const ocLines = ocRaw.map((l) => JSON.parse(shift(l, Date.now() - 120_000 - ocLast)));
  const ocDir = join(HOME, ".local", "share", "opencode");
  mkdirSync(ocDir, { recursive: true });
  const db = new DatabaseSync(join(ocDir, "opencode.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, parent_id TEXT, version TEXT NOT NULL, time_created INTEGER NOT NULL)");
  db.exec("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)");
  const ocHead = ocLines[0];
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, NULL, ?, ?)").run(ocHead.id, mono, ocHead.version, ocHead.time_created);
  const addRow = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");

  for (const m of ocLines.slice(1)) addRow.run(m.id, ocHead.id, m.type, m.seq, m.time_created, m.time_created, JSON.stringify(m.data));
  // An answer still streaming: no time.completed yet.
  const lastSeq = Math.max(...ocLines.slice(1).map((m) => m.seq));
  addRow.run("msg_streaming", ocHead.id, "assistant", lastSeq + 3, Date.now(), Date.now(), JSON.stringify({ time: { created: Date.now() }, model: { id: "big-pickle", providerID: "opencode" }, content: [{ type: "text", text: "Placeholder answer, still streaming" }] }));
  const ocId = sessionId("opencode", ocHead.id);

  // A session elsewhere on this machine: never sent.
  const otherHead = { ...piHead, id: "elsewhere-1", cwd: join(work, "not-pando") };
  writeFileSync(join(piDir, "elsewhere.jsonl"), [JSON.stringify(otherHead), ...piLines.slice(1, 4).map((l) => shift(l, piShift))].join("\n") + "\n");

  sync = startSync(mono);

  const piView = await waitFor(async () => {
    const v = (await call("GET", `/v1/monorepos/${full}/sessions/${piId}`, S)).json;

    return v?.end > 0 ? v : null;
  });

  check("pando sync sends the Pi session from the worktree, with its repository and branch", piView?.repo === "projects-app" && piView.branch === "fix-login" && piView.machine === "scli-box" && piView.prompts === 1, JSON.stringify(piView ?? {}).slice(0, 200) + scrub(sync.log.text.slice(-300)));

  const ocView = await waitFor(async () => {
    const v = (await call("GET", `/v1/monorepos/${full}/sessions/${ocId}`, S)).json;

    return v?.end > 0 ? v : null;
  });

  check("and the OpenCode V2 session from the repository folder", ocView?.repo === null && ocView.branch === null && ocView.prompts === 2 && ocView.end === lastSeq, `${ocView?.end} vs ${lastSeq}`);
  r = await call("GET", `/v1/monorepos/${full}/sessions`, S);
  check("only these two: the session in another folder is never sent", r.json?.sessions?.length === 2, `${r.json?.sessions?.length}`);
  db.prepare("UPDATE session_message SET data = ? WHERE id = ?").run(JSON.stringify({ time: { created: Date.now(), completed: Date.now() }, model: { id: "big-pickle", providerID: "opencode" }, content: [{ type: "text", text: "Placeholder answer, done" }] }), "msg_streaming");

  const ocDone = await waitFor(async () => {
    const v = (await call("GET", `/v1/monorepos/${full}/sessions/${ocId}`, S)).json;

    return v?.end === lastSeq + 3 ? v : null;
  });

  check("the streaming answer is sent once it has finished, not before", !!ocDone && ocDone.models[0].answers === 5, JSON.stringify(ocDone?.models));

  // Growth, a partial line, and secrets.
  const fakeToken = `ghp_${"Zx9Kq2Lm".repeat(5)}`;
  const awsKey = "AKIAZ4XQ7J2KLM3N5P6R";
  const grow = JSON.parse(shift(piLines[6], piShift));
  grow.message.content = [{ type: "text", text: `Placeholder: here is ${fakeToken} and ${awsKey}` }];
  appendFileSync(piFile, JSON.stringify(grow) + "\n" + piLines.slice(7).map((l) => shift(l, piShift)).join("\n"));

  const grown = await waitFor(async () => {
    const v = (await call("GET", `/v1/monorepos/${full}/sessions/${piId}`, S)).json;

    return v?.prompts === 2 ? v : null;
  });

  check("new whole lines are appended; the last line, still partial, is not", !!grown && grown.end < readFileSync(piFile).length, `${grown?.end} of ${readFileSync(piFile).length}`);
  check("the secrets were removed on the machine (the server counts the marks)", grown?.redactions >= 2, `${grown?.redactions}`);
  r = await call("GET", `/v1/monorepos/${full}/sessions/${piId}/entries`, S);
  const text = JSON.stringify(r.json);
  check("neither secret reached the server", !text.includes(fakeToken) && !text.includes(awsKey) && text.includes("[pando:redacted]"), "");
  appendFileSync(piFile, "\n");

  const whole = await waitFor(async () => {
    const v = (await call("GET", `/v1/monorepos/${full}/sessions/${piId}`, S)).json;

    return v?.end === readFileSync(piFile).length ? v : null;
  });

  check("once its newline is written, the last line goes too", !!whole, "");

  // The machine's state reaches Settings.
  r = await call("GET", "/v1/user/session-machines", S);
  record("session-machines.json", "SessionMachines", "GET /v1/user/session-machines", r);
  const box = r.json?.machines?.find((m) => m.machine === "scli-box");
  check("the machine reports recording on and the stores it reads", box?.recording === true && box.stores.some((s) => s.program === "pi" && s.found === "default") && box.stores.some((s) => s.program === "opencode"), JSON.stringify(box ?? {}).slice(0, 200));

  // A failure in session reading never stops the shared files: a broken state file stops sessions, not the sync.
  const stateFile = join(mono, ".pando", "local", "sessions.json");
  rmSync(stateFile);
  mkdirSync(stateFile); // its state can no longer be saved: every pass of session reading fails
  writeFileSync(join(mono, "AGENTS.md"), "notes, changed while sessions fail\n");
  let last = null;

  const saved = await waitFor(async () => {
    last = await call("GET", `/v1/monorepos/${full}/meta/file?path=AGENTS.md`, S);

    return last.status === 200 && last.text.includes("changed while sessions fail");
  }, 20_000);

  check("with session reading failing (logged), the shared files still sync", !!saved && /pando sync \(sessions\)/.test(sync.log.text), `${last?.status} ${scrub(sync.log.text.split("\n").filter((l) => /sessions/.test(l)).slice(-2).join(" | "))}`);
  await stopSync();

  // Resume with no state at all: from the server's end, nothing sent twice.
  rmSync(stateFile, { recursive: true });
  const before = (await call("GET", `/v1/monorepos/${full}/sessions/${piId}`, S)).json;
  appendFileSync(piFile, piLines.slice(3, 5).map((l) => shift(JSON.stringify({ ...JSON.parse(l), id: `${JSON.parse(l).id}-again` }), piShift + 1000)).join("\n") + "\n");
  sync = startSync(mono);

  const after = await waitFor(async () => {
    const v = (await call("GET", `/v1/monorepos/${full}/sessions/${piId}`, S)).json;

    return v?.end === readFileSync(piFile).length ? v : null;
  });

  check("a machine that lost its place resumes from the server's end: only the new lines are added", after?.prompts === before.prompts + 1 && after.tool_calls === before.tool_calls + 1, `${before.prompts}->${after?.prompts}`);

  // Exclusions.
  r = await pando(["session", "exclude", "--project", "projects/app"], { cwd: mono });
  check("pando session exclude --project projects/app", r.status === 0 && /Not recorded from now on/.test(r.stdout), said(r));
  r = await call("GET", "/v1/user/session-exclusions", S);
  record("session-exclusions.json", "SessionExclusions", "GET /v1/user/session-exclusions", r);
  check("the list is the person's own, on the server", r.json?.exclusions?.length === 1 && r.json.exclusions[0].monorepo === full && r.json.exclusions[0].project === "projects/app", JSON.stringify(r.json));
  await stopSync();
  sync = startSync(mono);
  const exHead = { ...piHead, id: "excluded-1" };
  writeFileSync(join(piDir, "excluded.jsonl"), [JSON.stringify(exHead), ...piLines.slice(1, 6).map((l) => shift(l, piShift))].join("\n") + "\n");
  await sleep(3000);
  r = await call("GET", `/v1/monorepos/${full}/sessions/${sessionId("pi", "excluded-1")}`, S);
  check("a new session in an excluded project is not sent", r.status === 404, `${r.status}`);
  write("a.txt", "8\n");
  as("codex", { CODEX_THREAD_ID: "thread-3" }, ["git", "commit", "-qam", "excluded"], wt);
  check("and its commits carry no session line", lines().length === 0, `${lines()}`);
  r = await pando(["session", "include", "--project", "projects/app"], { cwd: mono });
  check("pando session include gives it back", r.status === 0 && /Recorded again/.test(r.stdout), said(r));

  // Delete: gone at once, and never sent again.
  r = await pando(["session", "delete", piId], { cwd: mono });
  check("pando session delete", r.status === 0 && /Deleted/.test(r.stdout), said(r));
  appendFileSync(piFile, piLines.slice(3, 5).map((l) => shift(JSON.stringify({ ...JSON.parse(l), id: `${JSON.parse(l).id}-late` }), piShift + 2000)).join("\n") + "\n");
  await sleep(3000);
  r = await call("GET", `/v1/monorepos/${full}/sessions/${piId}`, S);
  check("lines written after the delete are not sent: it stays deleted", r.json?.state === "deleted", JSON.stringify(r.json));
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  check("the machine keeps numbers, never text", JSON.stringify(state).length < 4000 && !JSON.stringify(state).includes("Placeholder"), "");
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  await stopSync();
  await tw.cleanup();
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((x) => !x).length;

console.log(`\n${results.length - failed} passed, ${failed} failed`);

process.exit(failed ? 1 : 0);
