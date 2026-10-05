// Shared by the agents' end-to-end suites: the server address, checks,
// Pando's API, and git with the credential kept out of every output.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const BASE = (process.env.AGENTS_URL ?? "http://127.0.0.1:8863").replace(/\/$/, "");

export const BOOT =
  process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../../worker/.dev.vars", import.meta.url), "utf8"))?.[1];

export const scrub = (s) =>
  String(s)
    .replace(/pando_[a-f0-9]{20,}/g, "<credential>")
    .replace(/Basic [A-Za-z0-9+/=]{20,}/g, "Basic <credential>")
    .replace(/art_v\d+_[A-Za-z0-9]+/g, "<artifacts-token>");

export const say = (s) => console.log(scrub(s));

const results = [];

export function check(name, pass, detail = "") {
  results.push(!!pass);
  say(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "\n      " + String(detail).replace(/\n/g, "\n      ") : ""}`);
}

export function done() {
  const passed = results.filter(Boolean).length;
  say(`\n${passed} of ${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

export async function call(method, path, secret, body) {
  const headers = { authorization: `Bearer ${secret}` };
  const init = { method, headers };

  if (body) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const r = await fetch(BASE + path, init);
  const text = await r.text();
  let json;

  try {
    json = JSON.parse(text);
  } catch {}

  return { status: r.status, json, text };
}

/** Calls pando-agents' AgentsApi through the test driver. */
export async function agents(method, body) {
  const r = await fetch(`${BASE}/_agents/${method}`, { method: "POST", body: JSON.stringify(body) });
  const json = await r.json();

  if (r.status !== 200) throw new Error(`${method}: ${scrub(JSON.stringify(json))}`);

  return json;
}

const home = mkdtempSync(join(tmpdir(), "pando-agents-"));

/** git with the secret handed over by a helper reading the environment; no system config, no other helper. */
export function git(args, cwd, secret) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    PANDO_SECRET: secret ?? "",
    GIT_AUTHOR_NAME: "Tester",
    GIT_AUTHOR_EMAIL: "tester@pando.invalid",
    GIT_COMMITTER_NAME: "Tester",
    GIT_COMMITTER_EMAIL: "tester@pando.invalid",
  };

  const helper = ["-c", "credential.helper=", ...(secret ? ["-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f'] : [])];
  const r = spawnSync("git", [...helper, "-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8" });

  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

/** A person, a plain repository with these files on main, and the person's machine credential. */
export async function makeRepo(prefix, files) {
  const id = Date.now().toString(36);
  const login = `${prefix}-${id}`;
  const name = `${prefix}-${id}`;
  let r = await call("POST", "/v1/users", BOOT, { login, name: "Agent Tester", email: "tester@pando.invalid", credential_name: "tester-mbp" });
  const secret = r.json?.credential?.secret;
  check("a person with a machine credential", r.status === 201 && secret?.startsWith("pando_"), r.status);
  r = await call("POST", "/v1/monorepos", secret, { name, kind: "repo" });
  const cloneUrl = r.json?.repos?.[0]?.clone_url;
  const monorepoId = r.json?.monorepo?.id;
  check("a plain repository", r.status === 201 && !!cloneUrl && !!monorepoId, r.status);
  const work = mkdtempSync(join(tmpdir(), `pando-${prefix}-`));
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(src, path)), { recursive: true });
    writeFileSync(join(src, path), content);
  }

  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  const g = git(["push", "-q", cloneUrl, "main"], src, secret);
  check("main pushed", g.ok, g.out.slice(-300));

  return { login, name, full: `${login}/${name}`, secret, cloneUrl, monorepoId, work };
}
