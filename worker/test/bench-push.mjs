// Push benchmark: how many concurrent pushes a second one repository takes,
// and with what latency, against a running Pando (wrangler dev or a deploy).
//
//   PANDO_URL=http://localhost:8923 node test/bench-push.mjs
//   PANDO_URL=https://app.gitpando.com node test/bench-push.mjs --cred home --cred-host pando-dev.plannotator.workers.dev --seconds 30 --out run.json
//
// For each level N it runs N pushers for --seconds. A pusher has its own
// working copy of a project (one real clone per project, copied on disk), its
// own branch, and loops: change one file, commit, git push over HTTP. Per push
// it measures:
//   - accept: git push started to git push exited 0 (the server took it);
//   - visible: git push started to GET .../branches/<name> answering the new head;
//   - socket: git push started to the monorepo's event socket carrying the new head.
// Levels:
//   - the ladder (--levels, default 1,5,10,25,50), each level on one project of its own monorepo;
//     it stops raising N after a level that saw 429 or 5xx or failed over 20% of its pushes;
//   - spread (--spread-n pushers, default 25): across --spread monorepos (default 5) of one
//     project each, and across --spread projects of one monorepo, so the per-monorepo
//     object and the per-project Artifacts repo can be told apart;
//   - merge (--merge-n, default 1,10 pushers): each pushes a new branch and merges it
//     into main through the merge route, in a loop; each level on its own monorepo.
// --only ladder,spread,merge picks parts. Risk review is switched off on every
// project it makes, so merges wait for nothing and no model runs.
//
// Credentials: --cred bootstrap (default) makes a user with worker/.dev.vars'
// PANDO_BOOTSTRAP (or $PANDO_BOOTSTRAP); --cred home reads the signed-in CLI's
// credential, ~/.pando/credentials/<--cred-host, default the URL's host>. They
// are never printed. git runs with GIT_CONFIG_NOSYSTEM=1 and an emptied
// credential helper list, so it never reaches the keychain. Every monorepo it
// makes is named --prefix-... and deleted at the end (also on Ctrl-C).
//
// --server-log <file> reads the wrangler dev server's output afterwards and
// adds the door's own timing per level (time in the write gate, at Artifacts).
//
// Against anything but localhost it refuses over 50 pushers or 60 s a level.
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { describeError, retryResetFetch, throwaways } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const { values: opt } = parseArgs({
  options: {
    url: { type: "string", default: process.env.PANDO_URL ?? "http://localhost:8923" },
    cred: { type: "string", default: "bootstrap" },
    "cred-host": { type: "string" },
    levels: { type: "string", default: "1,5,10,25,50" },
    seconds: { type: "string", default: "30" },
    spread: { type: "string", default: "5" },
    "spread-n": { type: "string", default: "25" },
    "merge-n": { type: "string", default: "1,10" },
    only: { type: "string", default: "ladder,spread,merge" },
    prefix: { type: "string", default: `bench-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}` },
    out: { type: "string" },
    "server-log": { type: "string" },
  },
});

const URL_ = opt.url.replace(/\/$/, "");

const WS_ = URL_.replace(/^http/, "ws");

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(URL_);

const SECONDS = Number(opt.seconds);

const LEVELS = opt.levels.split(",").map(Number).filter((n) => n > 0);

const SPREAD = Number(opt.spread);

const SPREAD_N = Number(opt["spread-n"]);

const MERGE_NS = opt["merge-n"].split(",").map(Number).filter((n) => n > 0);

const ONLY = new Set(opt.only.split(","));

const most = Math.max(...LEVELS, SPREAD_N, ...MERGE_NS);

if (!LOCAL && (most > 50 || SECONDS > 60)) {
  console.error(`against ${URL_}: at most 50 pushers and 60 s a level (asked ${most} and ${SECONDS} s)`);
  process.exit(2);
}

/** A level's pushes that see a git push or API answer slower than this are still counted; the wait for a visible head stops here. */
const VISIBLE_WAIT_MS = 15_000;

const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>").replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<artifacts-token>");

let S = null;

const call = (method, path, body) => request(URL_, method, path, { secret: S, body });

const work = mkdtempSync(join(tmpdir(), "pando-bench-"));

const env = {
  ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Bench", GIT_AUTHOR_EMAIL: "bench@pando.invalid", GIT_COMMITTER_NAME: "Bench", GIT_COMMITTER_EMAIL: "bench@pando.invalid",
};

const gitArgs = ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main"];

/** git in the background: exit, stderr and stdout (scrubbed), and milliseconds taken. */
const git = (args, cwd) =>
  new Promise((resolve) => {
    const t0 = performance.now();
    const p = spawn("git", [...gitArgs, ...args], { cwd, env: { ...env, PANDO_SECRET: S ?? "" } });
    let out = "";
    let err = "";

    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ ok: code === 0, out: out.trim(), err: scrub(err).trim(), ms: performance.now() - t0 }));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Numbers ──────────────────────────────────────────────────────────────

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

const summary = (xs) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: xs.length ? Math.max(...xs) : null });

const ms = (x) => (x === null || x === undefined ? "-" : `${Math.round(x)}`);

/** A failed push, by what git said. */
function pushError(err) {
  const http = /returned error: (\d{3})/.exec(err)?.[1];

  if (http) return `http_${http}`;

  if (/busy with other/.test(err)) return "busy";

  if (/couldn't take this push/.test(err)) return "artifacts_failed";

  if (/\[rejected\]|non-fast-forward|fetch first/.test(err)) return "rejected";

  if (/\[remote rejected\]/.test(err)) return "remote_rejected";

  return `other: ${err.split("\n").slice(-1)[0].slice(0, 120)}`;
}

const isCeiling = (code) => /^http_(429|5\d\d)$/.test(code) || /^api_(429|5\d\d)$/.test(code);

// ── Monorepos, projects and their event sockets ──────────────────────────

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`)).status);

/** The seed every project starts from: a few files on main. */
async function seedDir() {
  const dir = join(work, "seed");
  mkdirSync(join(dir, "src"), { recursive: true });
  await git(["init", "-q"], dir);
  writeFileSync(join(dir, "README.md"), "# bench\n\nA throwaway project for Pando's push benchmark.\n");

  for (let i = 0; i < 5; i++) writeFileSync(join(dir, "src", `mod${i}.ts`), `export const value${i} = ${i};\n`);
  await git(["add", "-A"], dir);
  await git(["commit", "-qm", "seed"], dir);

  return dir;
}

let seed = null;

/** Watches one monorepo's event socket: when each `key@head` arrived (performance.now()). */
function watch(full) {
  const seen = new Map();
  const state = { seen, open: false, closed: null, ws: null };
  const ws = new WebSocket(`${WS_}/v1/monorepos/${full}/events`, { headers: { authorization: `Bearer ${S}` } });
  state.ws = ws;
  ws.onopen = () => {
    state.open = true;
    ws.send("ping");
  };

  ws.onmessage = (e) => {
    const at = performance.now();
    let f;

    try {
      f = JSON.parse(e.data);
    } catch {
      return;
    }

    if (f.type === "event" && f.head && f.key && !seen.has(`${f.key}@${f.head}`)) seen.set(`${f.key}@${f.head}`, at);
  };

  ws.onclose = (e) => (state.closed = e.code);

  return state;
}

/** A monorepo with `projects` projects (risk review off), main seeded on each; its socket open. */
async function makeMonorepo(name, projects) {
  const r = await call("POST", "/v1/monorepos", { name });

  if (r.status !== 201) throw new Error(`making ${name}: ${r.status} ${scrub(r.text).slice(0, 200)}`);
  const full = `${r.json.monorepo.owner}/${name}`;
  tw.add(full);
  const out = { full, projects: [], socket: null };

  for (let p = 0; p < projects; p++) {
    const made = await call("POST", `/v1/monorepos/${full}/repos`, { path: `projects/app${p}` });

    if (made.status !== 201) throw new Error(`adding a project to ${full}: ${made.status} ${scrub(made.text).slice(0, 200)}`);
    const repo = made.json.name;
    const off = await call("PATCH", `/v1/monorepos/${full}/repos/${repo}`, { review: { enabled: false } });

    if (off.status !== 200) throw new Error(`risk review off on ${full}/${repo}: ${off.status} ${scrub(off.text).slice(0, 200)}`);
    const url = made.json.clone_url;
    const pushed = await git(["push", "-q", url, "main"], seed);

    if (!pushed.ok) throw new Error(`seeding ${full}/${repo}: ${pushed.err}`);
    const clone = join(work, `clone-${name}-${repo}`);
    const cloned = await git(["clone", "-q", url, clone], work);

    if (!cloned.ok) throw new Error(`cloning ${full}/${repo}: ${cloned.err}`);
    out.projects.push({ full, repo, url, clone });
  }

  out.socket = watch(full);

  for (let i = 0; i < 100 && !out.socket.open; i++) await sleep(50);

  return out;
}

/** A pusher's own working copy of `project`, on its own new branch. */
async function workingCopy(project, label) {
  const dir = join(work, label);
  cpSync(project.clone, dir, { recursive: true });

  return dir;
}

/** Waits until GET branch answers `sha` as its head; the time it did (performance.now()), or null. */
async function visible(project, branch, sha, statuses) {
  const path = `/v1/monorepos/${project.full}/repos/${project.repo}/branches/${encodeURIComponent(branch)}`;
  const end = performance.now() + VISIBLE_WAIT_MS;

  while (performance.now() < end) {
    const r = await call("GET", path).catch(() => ({ status: 0, json: null }));

    if (r.status !== 200 && r.status !== 404) statuses.push(r.status);

    if (r.status === 200 && r.json?.head === sha) return performance.now();
    await sleep(25);
  }

  return null;
}

/** One change, committed: its sha. */
async function commitOne(dir, file, text) {
  writeFileSync(join(dir, file), text);
  await git(["add", file], dir);
  await git(["commit", "-qm", text.trim()], dir);

  return (await git(["rev-parse", "HEAD"], dir)).out;
}

// ── A push level ─────────────────────────────────────────────────────────

/** `n` pushers spread round-robin over `targets` (each {project, monorepo}) for SECONDS. */
async function pushLevel(label, targets, n) {
  const pushes = []; // { ok, t0, accept, visible, socketKey, monorepo, error }
  const apiStatuses = [];
  const dirs = await Promise.all(Array.from({ length: n }, (_, i) => workingCopy(targets[i % targets.length].project, `${label}-p${i}`)));
  const start = performance.now();
  const end = start + SECONDS * 1000;

  await Promise.all(dirs.map(async (dir, i) => {
    const { project, monorepo } = targets[i % targets.length];
    const branch = `${label}/p${i}`;
    let k = 0;

    while (performance.now() < end) {
      k++;
      const sha = await commitOne(dir, `p${i}.txt`, `${label} pusher ${i} change ${k}\n`);
      const t0 = performance.now();
      const g = await git(["push", "-q", project.url, `HEAD:refs/heads/${branch}`], dir);
      const t1 = performance.now();

      if (!g.ok) {
        pushes.push({ ok: false, t0, accept: t1 - t0, error: pushError(g.err), monorepo: monorepo.full });
        continue;
      }

      const seenAt = await visible(project, branch, sha, apiStatuses);
      pushes.push({ ok: true, t0, t1, accept: t1 - t0, visible: seenAt === null ? null : seenAt - t0, key: `${project.repo}/${branch}@${sha}`, socket: monorepo.socket, monorepo: monorepo.full });
    }
  }));

  const wall = (performance.now() - start) / 1000;
  await sleep(2000); // late socket frames

  for (const p of pushes) {
    if (!p.ok) continue;
    const at = p.socket.seen.get(p.key);
    p.socketMs = at === undefined ? null : at - p.t0;
    delete p.socket;
  }

  return report(label, n, targets, pushes, apiStatuses, wall);
}

function report(label, n, targets, pushes, apiStatuses, wall) {
  const ok = pushes.filter((p) => p.ok);
  const errors = {};

  for (const p of pushes.filter((x) => !x.ok)) errors[p.error] = (errors[p.error] ?? 0) + 1;

  for (const s of apiStatuses) errors[`api_${s}`] = (errors[`api_${s}`] ?? 0) + 1;
  const perMonorepo = {};

  for (const p of ok) perMonorepo[p.monorepo] = (perMonorepo[p.monorepo] ?? 0) + 1;

  const row = {
    label, n, targets: targets.length, monorepos: new Set(targets.map((t) => t.monorepo.full)).size, seconds: Math.round(wall * 10) / 10,
    attempts: pushes.length, accepted: ok.length, per_second: Math.round((ok.length / wall) * 100) / 100,
    accept: summary(ok.map((p) => p.accept)), visible: summary(ok.filter((p) => p.visible !== null).map((p) => p.visible)),
    socket: summary(ok.filter((p) => p.socketMs !== null).map((p) => p.socketMs)),
    not_visible: ok.filter((p) => p.visible === null).length, not_on_socket: ok.filter((p) => p.socketMs === null).length,
    errors, per_monorepo_per_second: Object.values(perMonorepo).map((c) => Math.round((c / wall) * 100) / 100),
    monorepo_names: [...new Set(targets.map((t) => t.monorepo.full))],
  };

  console.log(
    `${label.padEnd(14)} N=${String(n).padStart(2)} over ${row.targets} project(s) in ${row.monorepos} monorepo(s): ${row.accepted}/${row.attempts} accepted in ${row.seconds} s = ${row.per_second}/s; ` +
      `accept p50 ${ms(row.accept.p50)} p95 ${ms(row.accept.p95)} max ${ms(row.accept.max)} ms; visible p50 ${ms(row.visible.p50)} p95 ${ms(row.visible.p95)} ms; ` +
      `socket p50 ${ms(row.socket.p50)} p95 ${ms(row.socket.p95)} ms (${row.not_on_socket} missed); errors ${JSON.stringify(errors)}`,
  );

  return row;
}

// ── The merge level ──────────────────────────────────────────────────────

/** `n` pushers on one project, each in a loop: a new branch with one change, pushed, then merged into main. */
async function mergeLevel(label, monorepo, n) {
  const project = monorepo.projects[0];
  const merges = []; // { status, code, ms, push, t0, sha }
  const pushFails = [];
  const dirs = await Promise.all(Array.from({ length: n }, (_, i) => workingCopy(project, `${label}-p${i}`)));
  const start = performance.now();
  const end = start + SECONDS * 1000;

  await Promise.all(dirs.map(async (dir, i) => {
    let k = 0;

    while (performance.now() < end) {
      k++;
      const branch = `${label}/p${i}-${k}`;
      const sha = await commitOne(dir, `m${i}.txt`, `${label} pusher ${i} merge ${k}\n`);
      const g = await git(["push", "-q", project.url, `HEAD:refs/heads/${branch}`], dir);

      if (!g.ok) {
        pushFails.push(pushError(g.err));
        continue;
      }

      const t0 = performance.now();
      const r = await call("POST", `/v1/monorepos/${project.full}/repos/${project.repo}/branches/${encodeURIComponent(branch)}/merge`, { expected_head: sha }).catch((err) => ({ status: 0, json: null, text: describeError(err) }));
      const t1 = performance.now();
      merges.push({ status: r.status, code: r.json?.error?.code ?? r.json?.status ?? null, ms: t1 - t0, push: g.ms, t0, sha: r.json?.sha ?? null });

      if (r.status !== 200) await sleep(250);
    }
  }));

  const wall = (performance.now() - start) / 1000;
  await sleep(2000);
  const ok = merges.filter((m) => m.status === 200 && m.code === "merged");
  const socket = ok.map((m) => monorepo.socket.seen.get(`${project.repo}@${m.sha}`)).map((at, i) => (at === undefined ? null : at - ok[i].t0));
  const errors = {};

  for (const m of merges.filter((x) => !(x.status === 200 && x.code === "merged"))) errors[`merge_${m.status}_${m.code}`] = (errors[`merge_${m.status}_${m.code}`] ?? 0) + 1;

  for (const e of pushFails) errors[`push_${e}`] = (errors[`push_${e}`] ?? 0) + 1;

  const row = {
    label, n, seconds: Math.round(wall * 10) / 10, attempts: merges.length, merged: ok.length, per_second: Math.round((ok.length / wall) * 100) / 100,
    merge: summary(ok.map((m) => m.ms)), push: summary(merges.map((m) => m.push)), socket: summary(socket.filter((x) => x !== null)), errors,
    monorepo_names: [monorepo.full],
  };

  console.log(
    `${label.padEnd(14)} N=${String(n).padStart(2)}: ${row.merged}/${row.attempts} merged in ${row.seconds} s = ${row.per_second} merges/s into main; ` +
      `merge p50 ${ms(row.merge.p50)} p95 ${ms(row.merge.p95)} max ${ms(row.merge.max)} ms; branch push p50 ${ms(row.push.p50)} ms; main on socket p50 ${ms(row.socket.p50)} p95 ${ms(row.socket.p95)} ms; errors ${JSON.stringify(errors)}`,
  );

  return row;
}

// ── The server's side (wrangler dev only) ────────────────────────────────

/**
 * Each row's door timing from a wrangler dev log (--server-log, the dev
 * server's stdout): the pando.timing lines of its monorepos, as the time in
 * the write gate, at Artifacts and in all, for the receive-pack and for the
 * info/refs git asks for first.
 */
function serverTimings(file, rows) {
  const blocks = readFileSync(file, "utf8").split("\n{\n").slice(1).map((b) => b.split("\n}")[0]);
  const field = (b, k) => new RegExp(`^\\s*${k}: '?([^',\\n]*)'?,?$`, "m").exec(b)?.[1] ?? null;

  const lines = blocks.filter((b) => field(b, "kind") === "door" && field(b, "status") === "200").map((b) => ({
    monorepo: field(b, "monorepo"), route: field(b, "route"), service: field(b, "service"),
    total: Number(field(b, "total_ms")), gate: Number(field(b, "gate_ms")), artifacts: Number(field(b, "artifacts_ms")),
  }));

  for (const row of rows) {
    const mine = lines.filter((l) => row.monorepo_names.includes(l.monorepo));
    const packs = mine.filter((l) => l.route === "git-receive-pack");
    const refs = mine.filter((l) => l.route === "info/refs" && l.service === "git-receive-pack");
    row.server = {
      receive_pack: { total: summary(packs.map((l) => l.total)), gate: summary(packs.map((l) => l.gate)), artifacts: summary(packs.map((l) => l.artifacts)) },
      info_refs: { total: summary(refs.map((l) => l.total)), artifacts: summary(refs.map((l) => l.artifacts)) },
    };
    const rp = row.server.receive_pack;
    console.log(`${row.label.padEnd(14)} server: receive-pack p50 ${ms(rp.total.p50)} (gate ${ms(rp.gate.p50)}, Artifacts ${ms(rp.artifacts.p50)}) p95 ${ms(rp.total.p95)} (gate ${ms(rp.gate.p95)}) ms; info/refs p50 ${ms(row.server.info_refs.total.p50)} ms`);
  }
}

// ── The run ──────────────────────────────────────────────────────────────

const id = Date.now().toString(36);

const results = { url: URL_, started: new Date().toISOString(), seconds: SECONDS, ladder: [], spread: [], merge: [], ceiling: null };

let failed = false;

const sockets = [];

try {
  if (opt.cred === "home") {
    const host = opt["cred-host"] ?? new URL(URL_).host;
    S = readFileSync(join(homedir(), ".pando/credentials", host), "utf8").trim();
  } else {
    const boot = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];
    S = (await request(URL_, "POST", "/v1/users", { secret: boot, body: { login: `bench-${id}` } })).json?.credential?.secret ?? null;
  }

  const me = await call("GET", "/v1/user");

  if (me.status !== 200) throw new Error(`signing in: GET /v1/user answered ${me.status}`);
  console.log(`bench against ${URL_} as ${me.json?.login}, ${SECONDS} s a level`);
  seed = await seedDir();

  if (ONLY.has("ladder")) {
    for (const n of LEVELS) {
      // A monorepo per level, so the server's timing lines of a level are found by its name.
      const m = await makeMonorepo(`${opt.prefix}-${id}-n${n}`, 1);
      sockets.push(m.socket);
      const row = await pushLevel(`one-n${n}`, [{ project: m.projects[0], monorepo: m }], n);
      results.ladder.push(row);
      const hit = Object.keys(row.errors).filter(isCeiling);
      const failRate = row.attempts ? 1 - row.accepted / row.attempts : 1;

      if (hit.length || failRate > 0.2) {
        results.ceiling = { n, why: hit.length ? hit : [`${Math.round(failRate * 100)}% of pushes failed`] };
        console.log(`ceiling at N=${n}: ${results.ceiling.why.join(", ")}; not raising N`);
        break;
      }
    }
  }

  if (ONLY.has("spread") && SPREAD > 1) {
    const many = [];

    for (let s = 0; s < SPREAD; s++) many.push(await makeMonorepo(`${opt.prefix}-${id}-m${s}`, 1));
    sockets.push(...many.map((m) => m.socket));
    results.spread.push(await pushLevel(`monorepos-${SPREAD}`, many.map((m) => ({ project: m.projects[0], monorepo: m })), SPREAD_N));
    const wide = await makeMonorepo(`${opt.prefix}-${id}-wide`, SPREAD);
    sockets.push(wide.socket);
    results.spread.push(await pushLevel(`projects-${SPREAD}`, wide.projects.map((p) => ({ project: p, monorepo: wide })), SPREAD_N));
  }

  if (ONLY.has("merge")) {
    for (const n of MERGE_NS) {
      const m = await makeMonorepo(`${opt.prefix}-${id}-merge${n}`, 1);
      sockets.push(m.socket);
      results.merge.push(await mergeLevel(`merge-n${n}`, m, n));
    }
  }
} catch (err) {
  failed = true;
  console.log(`stopped: ${scrub(describeError(err))}`);
} finally {
  for (const s of sockets) s.ws?.close();

  if (opt["server-log"]) serverTimings(opt["server-log"], [...results.ladder, ...results.spread, ...results.merge]);
  const clean = await tw.cleanup();
  results.finished = new Date().toISOString();
  results.cleaned = clean;

  if (opt.out) writeFileSync(opt.out, JSON.stringify(results, null, 2));
  rmSync(work, { recursive: true, force: true });
  console.log(clean ? "deleted this run's monorepos" : "some monorepos were left behind (named above)");
  process.exit(failed || !clean ? 1 : 0);
}
