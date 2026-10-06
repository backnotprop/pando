// The deployed check: one agent with the default model (GLM-5.3 Flash) on a
// throwaway repository on a deployed Pando, through Pando's own launch
// route, on a branch named for the change (fix-readme-spelling). It reports the container's start, how the workspace held the
// branch, the model calls and their price, and the agent.updated states it
// saw; then it stops the session, revokes its credential and deletes the
// repository. It costs real money (under a cent): run it by hand.
//
//   PANDO_URL=https://pando-dev.<subdomain>.workers.dev PANDO_TOKEN_FILE=~/.pando/credentials/<host> node agents/test/deployed.mjs
//
// The token is read from the file and never printed; git gets it through a
// helper reading the environment, with the system config skipped and every
// other helper cleared first.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = (process.env.PANDO_URL ?? "").replace(/\/$/, "");

const TOKEN = readFileSync(process.env.PANDO_TOKEN_FILE ?? "", "utf8").trim();

const scrub = (s) => String(s).replaceAll(TOKEN, "<credential>").replace(/pando_[a-f0-9]{20,}/g, "<credential>");

const say = (s) => console.log(scrub(s));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, path, body) {
  const init = { method, headers: { authorization: `Bearer ${TOKEN}` } };

  if (body) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const r = await fetch(URL_ + path, init);
  const text = await r.text();
  let json;

  try {
    json = JSON.parse(text);
  } catch {}

  return { status: r.status, json, text };
}

const work = mkdtempSync(join(tmpdir(), "pando-deployed-"));

function git(args, cwd) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: work, PANDO_SECRET: TOKEN, GIT_AUTHOR_NAME: "Deployed check", GIT_AUTHOR_EMAIL: "check@pando.invalid", GIT_COMMITTER_NAME: "Deployed check", GIT_COMMITTER_EMAIL: "check@pando.invalid" };
  const helper = ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f'];
  const r = spawnSync("git", [...helper, "-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8" });

  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

if (!URL_ || !TOKEN) {
  console.error("Set PANDO_URL and PANDO_TOKEN_FILE.");
  process.exit(2);
}

const me = (await call("GET", "/v1/user")).json;

const name = `agents-check-${Date.now().toString(36)}`;

const full = `${me.login}/${name}`;

let launchedAt = 0;

/** The session's number once Pando took the launch (201); a refused launch made none. */
let launched = null;

let made = false;

const frames = [];

let ws;

try {
  let r = await call("POST", "/v1/monorepos", { name, kind: "repo" });

  if (r.status !== 201) throw new Error(`making the repository: ${r.status} ${r.text.slice(0, 300)}`);
  made = true;
  const cloneUrl = r.json.repos[0].clone_url;
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# Deployed check\n\nThis repository has one file. Its last line has a spelling mistake: recieve.\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  const g = git(["push", "-q", cloneUrl, "main"], src);

  if (!g.ok) throw new Error(`pushing main: ${g.out.slice(-300)}`);
  say(`repository ${full}, main pushed`);

  ws = new WebSocket(`${URL_.replace(/^http/, "ws")}/v1/monorepos/${full}/events?topics=agents`, { headers: { authorization: `Bearer ${TOKEN}` } });
  ws.onmessage = (m) => {
    if (m.data !== "pong") frames.push({ t: Date.now(), f: JSON.parse(m.data) });
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("the event socket did not open"));
  });

  launchedAt = Date.now();
  r = await call("POST", `/v1/monorepos/${full}/agents`, {
    branch: "fix-readme-spelling",
    prompt: "README.md has a spelling mistake on its last line. Fix it, commit with a short message, push your branch, then merge it with the merge tool. Then say in one sentence what you did.",
  });
  say(`launch: ${r.status} ${JSON.stringify(r.json)}`);

  if (r.status !== 201) throw new Error("the launch was refused");
  launched = r.json.number;

  do {
    await sleep(2000);
    r = await call("GET", `/v1/monorepos/${full}/agents/${launched}`);
  } while (r.json?.status === "working" && Date.now() - launchedAt < 600_000);

  say(`end: ${Math.round((Date.now() - launchedAt) / 1000)} s after the launch, ${JSON.stringify(r.json)}`);

  const tr = (await call("GET", `/v1/monorepos/${full}/agents/${launched}/transcript`)).json?.messages ?? [];
  const usage = { input: 0, cache_read: 0, output: 0, calls: 0 };
  let firstSandbox = null;
  let lastCall = null;

  for (const m of tr) {
    if (m.usage) {
      usage.input += m.usage.input;
      usage.cache_read += m.usage.cache_read;
      usage.output += m.usage.output;
      usage.calls += 1;
    }

    for (const p of m.parts) {
      if (p.type === "tool-call") lastCall = { name: p.name, at: m.at };

      if (p.type === "tool-result" && firstSandbox === null && ["read", "bash", "edit", "write"].includes(p.name)) firstSandbox = { name: p.name, ms: m.at - (lastCall?.at ?? m.at) };

      if (p.type === "text" && m.role === "assistant") say(`  model: ${p.text.slice(0, 240)}`);

      if (p.type === "tool-call") say(`  call:  ${p.name} ${p.arguments.slice(0, 160)}`);

      if (p.type === "tool-result") say(`  ${p.error ? "error" : "ok   "}  ${p.text.replace(/\n/g, " | ").slice(0, 200)}`);
    }
  }

  const dollars = ((usage.input - usage.cache_read) * 0.15 + usage.cache_read * 0.03 + usage.output * 0.5) / 1e6;
  say(`model: ${usage.calls} calls; ${usage.input} input tokens (${usage.cache_read} cached), ${usage.output} output; about $${dollars.toFixed(4)}`);
  say(`first sandbox tool (${firstSandbox?.name ?? "none"}), container start and mount included: ${firstSandbox ? `${firstSandbox.ms} ms` : "n/a"}`);
  say(`agent.updated states: ${frames.flatMap((x) => (x.f.kind === "agent.updated" ? [`${x.f.row.status}${x.f.row.workspace ? `/${x.f.row.workspace}` : ""} +${Math.round((x.t - launchedAt) / 100) / 10}s`] : [])).join(", ")}`);
  r = await call("GET", `/v1/monorepos/${full}/repos/${name}/files/README.md`);
  say(`main's README fixed: ${/receive/.test(r.text) && !/recieve/.test(r.text)}`);
} catch (error) {
  say(`STOPPED: ${error.stack ?? error}`);
} finally {
  ws?.close();

  // Only a launch Pando took has a session to stop and a credential to revoke.
  if (launched !== null) {
    const s = await call("POST", `/v1/monorepos/${full}/agents/${launched}/stop`);
    say(`stop: ${s.status} ${s.json?.status ?? ""}`);
    const creds = (await call("GET", "/v1/user/credentials")).json?.credentials ?? [];
    const cred = creds.find((c) => c.name === `cloud-${launched}` && Date.parse(c.created_at) >= launchedAt - 60_000);
    const v = cred ? await call("DELETE", `/v1/user/credentials/${cred.id}`) : { status: "none found" };
    say(`revoke cloud-${launched}: ${v.status}`);
  }

  if (made) {
    const d = await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`);
    say(`delete ${full}: ${d.status}`);
  }
}
