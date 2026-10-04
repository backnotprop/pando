// Losing access closes the person's open sockets (monorepo/access.ts,
// sockets.ts), end to end against wrangler dev: real D1 and Durable
// Objects, real Artifacts, real git, and the real pando binary.
//
// For each way access ends, the person has the monorepo's event socket and
// the shared files' live socket open; both must close with 4403 within a
// second, and nothing more arrives on them:
// - an owner removes them from the monorepo;
// - they are removed from the org that owns it (and someone with a row of
//   their own there keeps their sockets);
// - a transfer moves it out of the org they had it through.
// Then `pando sync` (the meta engine and the follower) as a member who is
// removed: it stops, says why, and keeps the folder's files.
//
//   npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to <dir>
//   npx wrangler dev --port 8837 --persist-to <dir>
//   PANDO_URL=http://localhost:8837 node test/access.mjs
//
// Credentials are never printed. Git never reaches the keychain: every git
// and pando run has its own HOME and no system config. It deletes every
// monorepo it made (organizations can't be deleted yet).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeError, retryResetFetch } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8837").replace(/\/$/, "");

const WS_ = URL_.replace(/^http/, "ws");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const scrub = (s) => String(s).replace(/pando_[a-f0-9]{20,}/g, "<credential>").replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<artifacts-token>");

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// connection: close, as cli.mjs: the pando runs leave pooled sockets idle long enough for wrangler dev to drop them.
const call = (method, path, secret, body) => request(URL_, method, path, { secret, body, headers: { connection: "close" } });

async function waitFor(pred, ms = 20_000, every = 50) {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await pred();

    if (v) return v;
    await sleep(every);
  }

  return null;
}

const blobSha = (bytes) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");

/**
 * A socket collecting JSON frames, with when and how it closed. It pings as
 * it opens, as the web does: the runtime lets a client go at once after a
 * close only once it has sent a frame (worker/src/sockets.ts), and Node's
 * WebSocket reports a close only then.
 */
function openSocket(path, secret) {
  const s = { frames: [], open: false, code: null, closedAt: null };
  s.ws = new WebSocket(WS_ + path, { headers: { authorization: `Bearer ${secret}` } });
  s.ws.onopen = () => {
    s.open = true;
    s.ws.send("ping");
  };

  s.ws.onmessage = (e) => {
    try {
      s.frames.push(JSON.parse(e.data));
    } catch {
      // pong
    }
  };

  s.ws.onclose = (e) => {
    s.code = e.code;
    s.closedAt = Date.now();
  };

  s.ws.onerror = () => {};

  return s;
}

/** A person's two sockets on a monorepo, both caught up: the event stream and the shared files' live sync. */
async function both(full, secret, machine) {
  const ev = openSocket(`/v1/monorepos/${full}/events?topics=all`, secret);
  const meta = openSocket(`/v1/monorepos/${full}/meta/socket`, secret);
  await waitFor(() => meta.open, 10_000);
  meta.ws.send(JSON.stringify({ type: "hello", since: 0, machine, agent: null, client: "access-test/1" }));
  const up = await waitFor(() => ev.frames.some((f) => f.type === "caught_up") && meta.frames.some((f) => f.type === "caught_up"), 10_000);

  return { ev, meta, up: !!up, close: () => [ev, meta].forEach((s) => s.ws.close()) };
}

/**
 * A socket read frame by frame, that never sends one: when the server's close
 * frame arrives, and its code (Node's WebSocket would wait for the connection
 * to end, which the runtime delays for such a socket).
 */
function silentSocket(path, secret) {
  const s = { closeAt: null, code: null, up: false };
  let buf = Buffer.alloc(0);
  const u = new URL(URL_ + path);

  const req = http.request({
    host: u.hostname, port: u.port, path: u.pathname + u.search,
    headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", authorization: `Bearer ${secret}` },
  });

  req.on("upgrade", (_res, sock, head) => {
    s.up = true;
    s.sock = sock;

    const read = (d) => {
      buf = Buffer.concat([buf, d]);

      while (buf.length >= 2) {
        let len = buf[1] & 0x7f;
        let at = 2;

        if (len === 126) [len, at] = [buf.readUInt16BE(2), 4];
        else if (len === 127) [len, at] = [Number(buf.readBigUInt64BE(2)), 10];

        if (buf.length < at + len) return;

        if ((buf[0] & 0x0f) === 8 && s.closeAt === null) [s.closeAt, s.code] = [Date.now(), len >= 2 ? buf.readUInt16BE(at) : null];
        buf = buf.subarray(at + len);
      }
    };

    read(head);
    sock.on("data", read);
    sock.on("error", () => {});
  });

  req.on("error", () => {});
  req.end();

  return s;
}

/** The HTTP answer to a socket upgrade (a refused one's status). */
function upgradeStatus(path, secret) {
  return new Promise((resolve) => {
    const u = new URL(URL_ + path);

    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", authorization: `Bearer ${secret}` },
    });

    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("upgrade", (_res, sock) => {
      sock.destroy();
      resolve(101);
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

const id = Date.now().toString(36);

const login = Object.fromEntries(["ana", "bo", "cy", "dee", "eve", "fay"].map((n) => [n, `${n}-${id}`]));

const ORG = `acc-${id}`;

const made = [];

const sockets = [];

const work = mkdtempSync(join(tmpdir(), "pando-access-"));

let S = {};

/** Make a monorepo (a meta layer and an event stream) as `secret`, under `owner` when given. */
async function make(name, secret, owner) {
  const r = await call("POST", "/v1/monorepos", secret, owner ? { name, owner } : { name });

  if (r.status === 201) made.push(r.json.monorepo.full_name);

  return r.json?.monorepo?.full_name ?? null;
}

/** Wait for a person's sockets to close; the slower one's time from `t0`, and both codes. */
async function closed(p, t0) {
  await waitFor(() => p.ev.code !== null && p.meta.code !== null, 5000);

  return { ms: Math.max(p.ev.closedAt ?? Infinity, p.meta.closedAt ?? Infinity) - t0, codes: `${p.ev.code}/${p.meta.code}` };
}

/** Activity in a monorepo as ana: a worktree report (an event) and a shared file saved (a live change). */
async function activity(full, anaMeta, tag) {
  await call("PUT", `/v1/monorepos/${full}/worktrees/wt_${tag}_${id}`, S.ana, { repo: ".", branch: `feat/${tag}`, path: `worktrees/${tag}`, machine: "ana-box", kind: "sparse" });
  const bytes = Buffer.from(`${tag}\n`);
  anaMeta.ws.send(JSON.stringify({ type: "save", id: tag, path: `notes/${tag}.md`, base_version: 0, sha: blobSha(bytes), bytes: bytes.toString("base64") }));
  await waitFor(() => anaMeta.frames.some((f) => f.type === "accepted" && f.id === tag), 10_000);
}

try {
  for (const n of Object.keys(login)) S[n] = (await call("POST", "/v1/users", BOOT, { login: login[n], credential_name: `${n}-box` })).json?.credential?.secret;
  check("six people", Object.values(S).every(Boolean));

  // ── 1. An owner removes bo from the monorepo ──
  {
    const full = await make(`acc1-${id}`, S.ana);
    await call("PUT", `/v1/monorepos/${full}/members/${login.bo}`, S.ana, { role: "member" });
    const ana = await both(full, S.ana, "ana-box");
    const bo = await both(full, S.bo, "bo-box");
    const silent = silentSocket(`/v1/monorepos/${full}/events?topics=main`, S.bo);
    sockets.push(ana, bo, { close: () => silent.sock?.destroy() });
    check("removal: bo's event socket and live socket are open and caught up", ana.up && bo.up && !!(await waitFor(() => silent.up, 5000)));
    await activity(full, ana.meta, "r1");
    const live = await waitFor(() => bo.ev.frames.some((f) => f.kind === "worktree.reported") && bo.meta.frames.some((f) => f.type === "change"), 10_000);
    check("removal: bo gets the monorepo's events and shared file changes", !!live);
    const t0 = Date.now();
    const r = await call("DELETE", `/v1/monorepos/${full}/members/${login.bo}`, S.ana);
    const c = await closed(bo, t0);
    check("removal: both of bo's sockets close with 4403 within a second", r.status === 204 && c.codes === "4403/4403" && c.ms < 1000, `${r.status}; ${c.codes} in ${c.ms} ms`);
    await waitFor(() => silent.closeAt !== null, 2000);
    check("removal: a socket that never sent a frame gets the 4403 close frame within a second too", silent.code === 4403 && silent.closeAt - t0 < 1000, `${silent.code} in ${silent.closeAt - t0} ms`);
    const n = [bo.ev.frames.length, bo.meta.frames.length];
    await activity(full, ana.meta, "r2");
    await waitFor(() => ana.ev.frames.some((f) => f.kind === "worktree.reported" && f.row?.id === `wt_r2_${id}`), 5000);
    await sleep(1000);
    check("removal: nothing more reaches bo; ana's sockets stay open and get it", bo.ev.frames.length === n[0] && bo.meta.frames.length === n[1] && ana.ev.code === null && ana.meta.code === null && ana.ev.frames.some((f) => f.row?.id === `wt_r2_${id}`), `${bo.ev.frames.length - n[0]} and ${bo.meta.frames.length - n[1]} more frames`);
    const again = [await upgradeStatus(`/v1/monorepos/${full}/events`, S.bo), await upgradeStatus(`/v1/monorepos/${full}/meta/socket`, S.bo)];
    check("removal: bo's reconnects are refused (403)", again.join() === "403,403", again.join());
    ana.close();
  }

  // ── 2. Removed from the org that owns it; a row of one's own keeps access ──
  {
    let r = await call("POST", "/v1/orgs", S.ana, { login: ORG });
    check("an org", r.status === 201, `${r.status}`);

    for (const n of ["cy", "dee", "eve"]) await call("PUT", `/v1/orgs/${ORG}/members/${login[n]}`, S.ana, { role: "member" });
    const full = await make(`acc2-${id}`, S.ana, ORG);
    // dee also has a row of her own here.
    await call("PUT", `/v1/monorepos/${full}/members/${login.dee}`, S.ana, { role: "member" });
    const ana = await both(full, S.ana, "ana-box");
    const cy = await both(full, S.cy, "cy-box");
    const dee = await both(full, S.dee, "dee-box");
    sockets.push(ana, cy, dee);
    check("org: cy's and dee's sockets on the org's monorepo are open", cy.up && dee.up);
    const t0 = Date.now();
    r = await call("DELETE", `/v1/orgs/${ORG}/members/${login.cy}`, S.ana);
    const c = await closed(cy, t0);
    check("org: removed from the org, cy's two sockets close with 4403 within a second", r.status === 204 && c.codes === "4403/4403" && c.ms < 1000, `${r.status}; ${c.codes} in ${c.ms} ms`);
    const n = [cy.ev.frames.length, cy.meta.frames.length];
    r = await call("DELETE", `/v1/orgs/${ORG}/members/${login.dee}`, S.ana);
    await activity(full, ana.meta, "o1");
    const deeGot = await waitFor(() => dee.ev.frames.some((f) => f.row?.id === `wt_o1_${id}`) && dee.meta.frames.some((f) => f.type === "change" && f.path === "notes/o1.md"), 10_000);
    check("org: dee, out of the org but with a row of her own, keeps both sockets and gets the next changes", r.status === 204 && !!deeGot && dee.ev.code === null && dee.meta.code === null, `${r.status}; ${dee.ev.code}/${dee.meta.code}`);
    check("org: nothing more reaches cy", cy.ev.frames.length === n[0] && cy.meta.frames.length === n[1]);
    ana.close();
    dee.close();
  }

  // ── 3. A transfer moves it out of the org eve had it through ──
  {
    const full = await make(`acc3-${id}`, S.ana, ORG);
    const ana = await both(full, S.ana, "ana-box");
    const eve = await both(full, S.eve, "eve-box");
    sockets.push(ana, eve);
    check("transfer: eve (in the org) has both sockets open", eve.up);
    const t0 = Date.now();
    const r = await call("PATCH", `/v1/monorepos/${full}`, S.ana, { owner: login.ana });
    const moved = r.json?.full_name;

    if (moved) made[made.indexOf(full)] = moved;
    const c = await closed(eve, t0);
    check("transfer: to ana's own namespace, eve's two sockets close with 4403 within a second", r.status === 200 && c.codes === "4403/4403" && c.ms < 1000, `${r.status}; ${c.codes} in ${c.ms} ms`);
    const n = [eve.ev.frames.length, eve.meta.frames.length];
    await activity(moved, ana.meta, "t1");
    await sleep(1000);
    check("transfer: ana keeps her sockets; nothing more reaches eve", ana.ev.code === null && ana.meta.code === null && eve.ev.frames.length === n[0] && eve.meta.frames.length === n[1]);
    ana.close();
  }

  // ── 4. pando sync as a member who is removed ──
  {
    const bin = join(work, "pando");
    const cliDir = fileURLToPath(new URL("../../cli", import.meta.url));
    const built = spawnSync("go", ["build", "-buildvcs=false", "-o", bin, "./cmd/pando"], { cwd: cliDir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
    check("the cli builds", built.status === 0, built.stderr?.slice(0, 200));

    const safe = (who) => ({
      HOME: join(work, `${who}-home`), XDG_CONFIG_HOME: join(work, `${who}-home`, ".config"), PANDO_HOME: join(work, `${who}-pando`),
      GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", PANDO_SERVER: "", PANDO_TOKEN: "", PANDO_AGENT: "", PANDO_NO_BROWSER: "1",
      PANDO_MACHINE: `${who}-box`, PANDO_WORKTREE_KIND: "sparse",
      GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@pando.invalid`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@pando.invalid`,
    });

    /** One pando run: its exit status and output. `keep`: return the running child instead. */
    const pando = (who, args, o = {}) => {
      mkdirSync(join(work, `${who}-home`), { recursive: true });
      const child = spawn(bin, args, { cwd: o.cwd ?? work, env: { ...process.env, ...safe(who) } });
      const out = { status: null, stdout: "", stderr: "", child };
      child.stdout.on("data", (d) => (out.stdout += d));
      child.stderr.on("data", (d) => (out.stderr += d));
      child.stdin.end(o.input ?? "");

      const done = new Promise((resolve) => {
        child.on("close", (code) => resolve(Object.assign(out, { status: code })));
        child.on("error", (err) => resolve(Object.assign(out, { status: -1, stderr: out.stderr + String(err.message) })));
      });

      return o.keep ? Object.assign(out, { done }) : done;
    };

    const said = (run) => scrub(`${run.status} ${run.stdout} ${run.stderr}`).trim().slice(-400);

    for (const who of ["ana", "fay"]) {
      const r = await pando(who, ["login", "--server", URL_, "--with-credential"], { input: S[who] + "\n" });
      check(`pando login as ${who}`, r.status === 0, said(r));
    }

    // ana's monorepo from a folder: projects/app a git repo, AGENTS.md a shared file.
    const name = `acc4-${id}`;
    const mono = join(work, name);
    const app = join(mono, "projects", "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(mono, "AGENTS.md"), "notes\n");
    writeFileSync(join(app, "main.go"), "package main\n");
    const git = (args, cwd) => spawnSync("git", ["-c", "credential.helper=", "-c", "init.defaultBranch=main", ...args], { cwd, env: { ...process.env, ...safe("ana") }, encoding: "utf8" });
    git(["init", "-q"], app);
    git(["add", "-A"], app);
    git(["commit", "-qm", "first"], app);
    let r = await pando("ana", ["init", "--yes", "--name", name], { cwd: mono });
    const full = `${login.ana}/${name}`;

    if (r.status === 0) made.push(full);
    check("pando init as ana", r.status === 0, said(r));
    await call("PUT", `/v1/monorepos/${full}/members/${login.fay}`, S.ana, { role: "member" });
    const clone = join(work, "fay-clone");
    r = await pando("fay", ["clone", full, clone]);
    check("pando clone as fay: the shared files are here", r.status === 0 && existsSync(join(clone, "AGENTS.md")), said(r));
    r = await pando("fay", ["worktree", "add", "projects/app", "feat-f"], { cwd: clone });
    check("pando worktree add as fay (so the follower holds the event socket)", r.status === 0, said(r));
    const sync = pando("fay", ["sync"], { cwd: clone, keep: true });

    const up = await waitFor(async () => {
      const conns = (await call("GET", `/v1/monorepos/${full}/meta/status`, S.ana)).json?.connections ?? [];
      const machines = (await call("GET", `/v1/monorepos/${full}/machines`, S.ana)).json?.machines ?? [];

      return conns.some((x) => x.machine === "fay-box") && machines.some((x) => x.name === "fay-box" && x.connected);
    }, 30_000, 300);

    check("pando sync as fay: connected for live sync and following (the machine is listed)", !!up, said(sync));
    const t0 = Date.now();
    await call("DELETE", `/v1/monorepos/${full}/members/${login.fay}`, S.ana);
    const ended = await Promise.race([sync.done, sleep(10_000).then(() => null)]);
    const ms = Date.now() - t0;

    if (!ended) sync.child.kill();
    check("pando sync stops when fay is removed, within 2 s", !!ended && ended.status === 1 && ms < 2000, `${ms} ms; ${said(sync)}`);
    check("... and says why: no access to the monorepo, the folder keeps its files", /you no longer have access to this monorepo; this folder keeps its files and stops syncing/.test(sync.stderr) && sync.stderr.includes(full) && existsSync(join(clone, "AGENTS.md")), said(sync));
    check("... the follower says so too", sync.stderr.includes(`follow: you no longer have access to ${full}; stopped following`), said(sync));
    // Removed while offline: the next start is refused (403 not_a_member) and stops the same way, without retrying.
    const again = await Promise.race([pando("fay", ["sync"], { cwd: clone }), sleep(15_000).then(() => null)]);
    check("pando sync started again after the removal: stops at once and says why", again?.status === 1 && /you no longer have access to this monorepo/.test(again.stderr), again ? said(again) : "still running after 15 s");
  }
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  for (const p of sockets) p.close();

  for (const full of made) {
    const r = await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`, S.ana);
    check(`delete ${full}`, r.status === 204, `${r.status}`);
  }

  // A clone's read-only main (worktrees/main) is made writable first.
  spawnSync("chmod", ["-R", "u+w", work]);
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
