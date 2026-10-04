// Push records follow Artifacts (research/plans/concurrency-2026-10-04,
// CODE-VS-MODEL.md P1 to P3): one test per trace TLC found.
//   (a) Artifacts takes a push but its answer is lost: git hears it landed,
//       the branch is recorded, the hook fires, the merge gate works.
//   (b) Two agents, the first one's record slow: the record ends at the
//       newest head, the events come in push order, and a merge naming the
//       older head is refused.
//   (c) A reconcile racing a new push never moves the record back.
//   (d) A push whose record and keep both fail is found by the periodic
//       compare of Artifacts' refs with the records.
//
//   npx wrangler dev --port 8797 --persist-to <dir> --var DOOR_TEST:1
//   PANDO_URL=http://localhost:8797 node test/lost.mjs
//
// Real git, real Artifacts, a web hook receiver on this machine.
// Credentials stay in memory and are never printed; git never reaches the
// keychain. It deletes its monorepo.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch, throwaways } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`.replace(/pando_[a-f0-9]{20,}/g, "<credential>"));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let S = null;

const call = (method, path, body, headers = {}) => request(URL_, method, path, { secret: S, body, headers });

const work = mkdtempSync(join(tmpdir(), "pando-lost-"));

const gitArgs = (args, extra) => ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...extra, ...args];

const gitEnv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S ?? "", GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" });

const scrub = (s) => s.replace(/pando_[a-f0-9]+/g, "<credential>");

const git = (args, cwd, extra = []) => {
  const r = spawnSync("git", gitArgs(args, extra), { cwd, encoding: "utf8", env: gitEnv() });

  return { ok: r.status === 0, out: scrub(`${r.stdout}${r.stderr}`) };
};

/** git in the background: resolves when it exits. */
const gitAsync = (args, cwd, extra = []) =>
  new Promise((resolve) => {
    const p = spawn("git", gitArgs(args, extra), { cwd, env: gitEnv() });
    let out = "";

    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ ok: code === 0, out: scrub(out) }));
  });

const header = (name, value) => ["-c", `http.extraHeader=${name}: ${value}`];

const commit = (dir, file, text) => {
  writeFileSync(join(dir, file), text);
  git(["add", "-A"], dir);
  git(["commit", "-qm", `${file}: ${text.trim()}`], dir);

  return git(["rev-parse", "HEAD"], dir).out.trim();
};

async function waitFor(pred, ms) {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await pred();

    if (v) return v;
    await sleep(100);
  }

  return null;
}

const id = Date.now().toString(36);

const O = `lost-${id}`;

const M = `lost-${id}`;

let made = false;

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`)).status);

const got = [];

const receiver = createServer((req, res) => {
  let raw = "";

  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    try {
      got.push({ event: req.headers["x-pando-event"], body: JSON.parse(raw) });
    } catch {}

    res.writeHead(200).end();
  });
});

try {
  S = (await call("POST", "/v1/users", { login: O }, { authorization: `Bearer ${BOOT}` })).json?.credential?.secret;
  let r = await call("POST", "/v1/monorepos", { name: M, kind: "repo" });
  made = r.status === 201;

  if (made) tw.add(`${O}/${M}`);
  const url = r.json?.repos?.[0]?.clone_url;
  check("a user and a plain repo", !!S && made && !!url, `${r.status}`);

  if (!url) throw new Error("no repo to test with");
  const base = `/v1/monorepos/${O}/${M}/repos/${M}`;
  await new Promise((res) => receiver.listen(0, "127.0.0.1", res));
  r = await call("POST", `${base}/hooks`, { type: "web", url: `http://127.0.0.1:${receiver.address().port}/h`, secret: "lost-secret", events: ["push"] });
  check("a web hook for pushes", r.status === 201, `${r.status}`);

  // Main requires the check ci; agent A's clone.
  const a = join(work, "a");
  mkdirSync(a);
  git(["init", "-q"], a);
  mkdirSync(join(a, ".pando"));
  commit(a, ".pando/pando.toml", '[repos."."]\nrequired_checks = ["ci"]\n');
  check("push main (pando.toml requires ci)", git(["push", "-q", url, "main"], a).ok);

  const branch = async (name) => (await call("GET", `${base}/branches/${encodeURIComponent(name)}`)).json;
  const events = async () => (await call("GET", `/v1/monorepos/${O}/${M}/events?since=0&limit=500`)).json?.events ?? [];
  const pushesOf = async (name) => (await events()).filter((e) => (e.kind === "push" || e.kind === "branch.opened") && e.collection === "branches" && e.key === `${M}/${name}`);
  const lsRemote = (name) => git(["ls-remote", url, `refs/heads/${name}`], a).out.split(/\s/)[0] ?? "";

  // A branch at X, pushed normally.
  const open = (name) => {
    git(["checkout", "-qb", name, "main"], a);
    const x = commit(a, `${name}.txt`, "x\n");
    git(["push", "-q", url, name], a);

    return x;
  };

  // (a) The answer is lost: git hears it landed; the branch, its push event and its hook delivery follow; the gate works.
  open("a-lost");
  const y = commit(a, "a-lost.txt", "y\n");
  let g = git(["push", url, "a-lost"], a, header("X-Pando-Test-Lose-Answer", "1"));
  check("(a) a push whose answer from Artifacts is lost: git exits 0", g.ok, g.out.split("\n").filter(Boolean).slice(-2).join(" | "));
  check("(a) Artifacts has it", lsRemote("a-lost") === y);
  const recorded = await waitFor(async () => ((await branch("a-lost"))?.head === y ? true : null), 1_000);
  check("(a) the branch is recorded at the pushed head within 1 s", !!recorded, (await branch("a-lost"))?.head?.slice(0, 7));
  const pushY = (await pushesOf("a-lost")).filter((e) => e.kind === "push" && e.head === y);
  check("(a) exactly one push event for it", pushY.length === 1, `${pushY.length}`);
  const delivered = await waitFor(() => (got.filter((x) => x.event === "push" && x.body?.branch === "a-lost" && x.body?.head === y).length ? true : null), 10_000);
  await sleep(500);
  check("(a) the hook got one delivery for it", !!delivered && got.filter((x) => x.event === "push" && x.body?.branch === "a-lost" && x.body?.head === y).length === 1, `${got.filter((x) => x.body?.branch === "a-lost").length} for the branch`);
  r = await call("POST", `${base}/branches/a-lost/merge`, { expected_head: y });
  check("(a) the merge waits for ci on it (412 missing)", r.status === 412 && r.json?.error?.checks?.missing?.[0] === "ci", `${r.status} ${r.json?.error?.code}`);
  await call("POST", `${base}/statuses/${y}`, { context: "ci", state: "success" });
  r = await call("POST", `${base}/branches/a-lost/merge`, { expected_head: y });
  check("(a) and merges once ci passes", r.status === 200 && r.json?.status === "merged", `${r.status} ${r.json?.status ?? r.json?.error?.code}`);

  // (b) Agent A's record is slow; agent B pushes on top of A's push meanwhile. The record ends at B's head.
  git(["checkout", "-q", "main"], a);
  git(["pull", "-q", url, "main"], a);
  open("b-order");
  const bdir = join(work, "b");
  git(["clone", "-q", "--branch", "b-order", url, bdir], work);
  const yb = commit(a, "b-order.txt", "y\n");
  const slow = gitAsync(["push", url, "b-order"], a, header("X-Pando-Test-Record-Delay-Ms", "6000"));
  const landed = await waitFor(() => (lsRemote("b-order") === yb ? true : null), 10_000);
  git(["pull", "-q", "--ff-only", "origin", "b-order"], bdir);
  const z = commit(bdir, "b-order.txt", "z\n");
  const fast = git(["push", url, "b-order"], bdir);
  const first = await slow;
  check("(b) both pushes land: A's (its record slowed 6 s), then B's on top of it", !!landed && first.ok && fast.ok, `${first.ok} ${fast.ok}`);

  const settled = await waitFor(async () => {
    const b = await branch("b-order");

    return b?.head === z && b.stale === false ? b : null;
  }, 15_000);

  check("(b) the record ends at B's head, with facts for it", !!settled, `${(await branch("b-order"))?.head?.slice(0, 7)} vs ${z.slice(0, 7)}`);
  const order = (await pushesOf("b-order")).filter((e) => e.head === yb || e.head === z).map((e) => (e.head === yb ? "Y" : "Z"));
  check("(b) the push events come in push order: Y, then Z", order.join(",") === "Y,Z", order.join(","));
  r = await call("POST", `${base}/branches/b-order/merge`, { expected_head: yb });
  check("(b) a merge naming A's head is refused: the branch moved (409 head_moved)", r.status === 409 && r.json?.error?.code === "head_moved", `${r.status} ${r.json?.error?.code}`);

  // (c) A push is kept for the reconcile; while a branch list reconciles (paused between its refs read and the write), another push lands.
  git(["checkout", "-q", "main"], a);
  open("c-race");
  const yc = commit(a, "c-race.txt", "y\n");
  g = git(["push", url, "c-race"], a, header("X-Pando-Test-Record-Fail", "1"));
  await sleep(300);
  const list = call("GET", `${base}/branches?state=open`, undefined, { "x-pando-test-reconcile-pause-ms": "4000" });
  await sleep(1_000);
  const zc = commit(a, "c-race.txt", "z\n");
  const zPush = git(["push", url, "c-race"], a);
  const listed = await list;
  check("(c) a kept push, a list reconciling it, and a push landing meanwhile", g.ok && zPush.ok && listed.status === 200, `${g.ok} ${zPush.ok} ${listed.status}`);
  const after = await waitFor(async () => ((await branch("c-race"))?.head === zc ? true : null), 3_000);
  check("(c) the record ends at the newest head, not the one the list read", !!after, `${(await branch("c-race"))?.head?.slice(0, 7)} vs ${zc.slice(0, 7)} (read ${yc.slice(0, 7)})`);
  const back = (await pushesOf("c-race")).filter((e) => e.before === zc);
  check("(c) no push event moves it back from the newest head", back.length === 0, back.map((e) => `${e.before?.slice(0, 7)}->${e.head?.slice(0, 7)}`).join(","));
  await call("GET", `${base}/branches?state=open`);
  check("(c) the next list leaves it there", (await branch("c-race"))?.head === zc);

  // (d) The record fails and keeping the push fails too: the periodic compare of Artifacts' refs finds it.
  git(["checkout", "-q", "main"], a);
  open("d-sweep");
  const yd = commit(a, "d-sweep.txt", "y\n");
  const t0 = Date.now();
  // The compare's interval is 1 s for this push only (X-Pando-Test-Refs-Check-Ms), so the other checks above meet no compare.
  g = git(["push", url, "d-sweep"], a, [...header("X-Pando-Test-Record-Fail", "1"), ...header("X-Pando-Test-Keep-Fail", "1"), ...header("X-Pando-Test-Refs-Check-Ms", "1000")]);
  const found = await waitFor(async () => ((await branch("d-sweep"))?.head === yd ? true : null), 5_000);
  check("(d) a push whose record and keep both fail is recorded by the refs compare (every 1 s here)", g.ok && !!found, `${found ? Date.now() - t0 : "never"} ms after the push started`);
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  receiver.close();

  if (made) check(`delete ${O}/${M}`, await tw.cleanup());
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
