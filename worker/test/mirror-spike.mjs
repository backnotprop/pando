// The mirror spike: a Pando repo of 1, 50 and 500 MB sent through the pipe
// (Artifacts' upload-pack into a receive-pack) to the git stand-in on this
// machine, timed; then one small change sent as a thin pack.
//
//   npx wrangler dev --port 8831 --persist-to <dir> --var MIRROR_TEST:1
//   PANDO_URL=http://localhost:8831 node test/mirror-spike.mjs [sizes in MB, default 1 50 500]
//
// Files are random bytes (incompressible), at most 8 MB each, pushed to Pando
// in steps of about 24 MB (bigger pushes through a local door often came back
// "couldn't take this push right now"). Each test repo is
// deleted at the end. Credentials are never printed.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retryResetFetch } from "./errors.mjs";
import { startGitStandin } from "./git-standin.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8831").replace(/\/$/, "");

const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const call = (method, path, secret, body) => request(URL_, method, path, { secret, body });

// The pipe op is idempotent, so a POST on a keep-alive socket the server closed while git pushed is sent again.
const pipe = async (body) => {
  try {
    return await call("POST", "/v1/_mirror/test", BOOT, body);
  } catch (err) {
    if (!/ECONNRESET|socket/i.test(String(err?.cause ?? err))) throw err;

    return call("POST", "/v1/_mirror/test", BOOT, body);
  }
};

const sizes = process.argv.slice(2).map(Number).filter(Boolean);

const SIZES = sizes.length ? sizes : [1, 50, 500];

const standin = await startGitStandin(Number(process.env.STANDIN_PORT ?? 8835));

const work = mkdtempSync(join(tmpdir(), "pando-mirror-spike-"));

const id = Date.now().toString(36);

const S = (await call("POST", "/v1/users", BOOT, { login: `ms-${id}` })).json?.credential?.secret;

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" };

const git = (a, cwd) => spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", "-c", "http.postBuffer=524288000", ...a], { cwd, env, encoding: "utf8", maxBuffer: 1 << 26 });

const rows = [];

for (const mb of SIZES) {
  const name = `ms-${id}-${mb}`;
  let owner = null;

  try {
    const r = await call("POST", "/v1/monorepos", S, { name, kind: "repo" });
    owner = r.json?.monorepo?.owner;
    const mid = r.json?.monorepo?.id;
    const url = r.json?.repos?.[0]?.clone_url;
    const src = join(work, name);
    mkdirSync(src);
    git(["init", "-q"], src);
    let left = mb * 1024 * 1024;
    let step = 0;
    let pushMs = 0;

    while (left > 0) {
      let inStep = 0;

      while (left > 0 && inStep < 24 * 1024 * 1024) {
        const n = Math.min(left, 8 * 1024 * 1024, mb === 1 ? 1024 * 1024 : Infinity);
        writeFileSync(join(src, `blob-${step}-${inStep}`), randomBytes(n));
        left -= n;
        inStep += n;
      }

      git(["add", "-A"], src);
      git(["commit", "-qm", `step ${step}`], src);
      const t = Date.now();
      // Steps go to a branch (main is protected); main is made from the last step.
      let p = git(["push", "-q", url, "HEAD:refs/heads/load"], src);

      // Setup only: a big push the door could not take right now is sent again (up to 8 times).
      for (let i = 0; i < 8 && p.status !== 0 && /push again|Broken pipe/.test(p.stderr); i++) {
        await new Promise((r) => setTimeout(r, 2000));
        p = git(["push", "-q", url, "HEAD:refs/heads/load"], src);
      }

      pushMs += Date.now() - t;

      if (p.status !== 0) throw new Error(`push step ${step} failed: ${p.stderr.slice(0, 300)}`);
      step++;
    }

    if (git(["push", "-q", url, "HEAD:refs/heads/main"], src).status !== 0) throw new Error("making main failed");
    const head = git(["rev-parse", "HEAD"], src).stdout.trim();
    const target = `spike/${name}`;
    const full = await pipe({ op: "pipe", monorepo: mid, url: standin.url(target) });
    const landed = standin.git(target, "rev-parse", "refs/heads/main").stdout.trim();
    const fsck = standin.git(target, "fsck", "--no-progress").status === 0;
    // One small change: a thin pack against what the target has.
    writeFileSync(join(src, "small"), randomBytes(64 * 1024));
    git(["add", "-A"], src);
    git(["commit", "-qm", "small"], src);
    git(["push", "-q", url, "HEAD:refs/heads/small"], src);
    const merged = await call("POST", `/v1/monorepos/${owner}/${name}/repos/${name}/branches/small/merge?force=1`, S);
    const head2 = merged.json?.sha;
    const thin = await pipe({ op: "pipe", monorepo: mid, url: standin.url(target) });
    const landed2 = standin.git(target, "rev-parse", "refs/heads/main").stdout.trim();
    rows.push({
      mb,
      push_to_pando_s: (pushMs / 1000).toFixed(1),
      full: { ok: landed === head && fsck, total_ms: full.json?.total_ms, first_pack_byte_ms: full.json?.first_pack_byte_ms, pack_mb: ((full.json?.pack_bytes ?? 0) / 1048576).toFixed(1), unpack: full.json?.report?.unpack, error: full.json?.error ?? full.json?.report?.error ?? null },
      thin: { ok: landed2 === head2, total_ms: thin.json?.total_ms, pack_kb: ((thin.json?.pack_bytes ?? 0) / 1024).toFixed(0), answer: landed2 === head2 ? null : thin.text.slice(0, 400) },
    });
    console.log(JSON.stringify(rows.at(-1)));
  } catch (err) {
    console.log(JSON.stringify({ mb, error: String(err).slice(0, 300), cause: String(err?.cause ?? "").slice(0, 300) }));
  } finally {
    if (owner && !process.env.KEEP) await call("DELETE", `/v1/monorepos/${owner}/${name}?confirm=${owner}/${name}`, S);
  }
}

await standin.close();

rmSync(work, { recursive: true, force: true });
