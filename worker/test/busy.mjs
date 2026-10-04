// The git door's busy retry: Artifacts runs about 2 receive-packs at once per
// repo and answers others "busy". A push up to 1 MiB is held in memory and
// sent again once after a short wait; a larger one gets a plain "push again".
//
//   npx wrangler dev --port 8797 --var DOOR_TEST:1
//   PANDO_URL=http://localhost:8797 node test/busy.mjs
//
// With DOOR_TEST=1, a push carrying X-Pando-Test-Busy: 1 has its first attempt
// taken as busy without being sent, so both paths run on demand; one carrying
// X-Pando-Test-Record-Fail: 1 lands in Artifacts but is not recorded, and the
// next branch list reconciles it (C2). Real git, real Artifacts, a web hook
// receiver on this machine. Credentials stay in memory; git never reaches the
// keychain.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8797").replace(/\/$/, "");

const BOOT = process.env.PANDO_BOOTSTRAP ?? /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../.dev.vars", import.meta.url), "utf8"))?.[1];

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`.replace(/pando_[a-f0-9]{20,}/g, "<credential>"));
};

const call = (method, path, secret, body) => request(URL_, method, path, { secret, body });

const work = mkdtempSync(join(tmpdir(), "pando-busy-"));

let S = null;

const git = (args, cwd, extra = []) => {
  const r = spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...extra, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S ?? "", GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" },
  });

  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.replace(/pando_[a-f0-9]+/g, "<credential>") };
};

const BUSY = ["-c", "http.extraHeader=X-Pando-Test-Busy: 1"];

const id = Date.now().toString(36);

const M = `busy-${id}`;

let O = null;

try {
  S = (await call("POST", "/v1/users", BOOT, { login: `busy-${id}` })).json?.credential?.secret;
  const r = await call("POST", "/v1/monorepos", S, { name: M, kind: "repo" });
  O = r.json?.monorepo?.owner ?? null;
  const url = r.json?.repos?.[0]?.clone_url;
  check("a plain repo", r.status === 201 && !!url);
  const src = join(work, "src");
  mkdirSync(src);
  git(["init", "-q"], src);
  writeFileSync(join(src, "README.md"), "# busy\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "first"], src);
  check("push main", git(["push", "-q", url, "main"], src).ok);

  // Small: the first attempt is taken as busy; the door waits and sends it again.
  git(["checkout", "-qb", "small"], src);
  writeFileSync(join(src, "a.txt"), "small change\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "small"], src);
  const t = Date.now();
  let g = git(["push", "-q", url, "small"], src, BUSY);
  const ms = Date.now() - t;
  check("a small push refused once as busy goes through on the door's retry", g.ok, g.ok ? `${ms} ms` : g.out.slice(-300));
  let b = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/branches/small`, S);
  check("and its branch is recorded", b.status === 200 && b.json?.name === "small", `${b.status}`);

  // Large (over 1 MiB): not held in memory, so not retried: a plain message.
  git(["checkout", "-qb", "large", "main"], src);
  writeFileSync(join(src, "big.bin"), randomBytes(1_600_000));
  git(["add", "-A"], src);
  git(["commit", "-qm", "large"], src);
  g = git(["push", "-q", url, "large"], src, BUSY);
  check("a push over 1 MiB refused as busy fails with a plain message", !g.ok && /busy with other pushes right now; push again/.test(g.out) && !/artifacts_git_receive_pack_busy/.test(g.out), g.out.split("\n").filter(Boolean).slice(0, 2).join(" | "));
  b = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/branches/large`, S);
  check("and nothing was pushed", b.status === 404, `${b.status}`);
  g = git(["push", "-q", url, "large"], src);
  check("pushing it again goes through", g.ok, g.out.slice(-200));
  b = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/branches/large`, S);
  check("and its branch is recorded", b.status === 200, `${b.status}`);

  // A failed Artifacts call (X-Pando-Test-Fail: the first attempt throws, unsent): never a bare 500.
  const FAIL = ["-c", "http.extraHeader=X-Pando-Test-Fail: 1"];
  git(["checkout", "-qb", "small-fail", "main"], src);
  writeFileSync(join(src, "f.txt"), "after a failed call\n");
  git(["add", "-A"], src);
  git(["commit", "-qm", "small-fail"], src);
  g = git(["push", "-q", url, "small-fail"], src, FAIL);
  b = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/branches/small-fail`, S);
  check("a small push whose first Artifacts call fails goes through on the retry", g.ok && b.status === 200, g.ok ? `${b.status}` : g.out.slice(-200));
  git(["checkout", "-qb", "large-fail", "main"], src);
  writeFileSync(join(src, "big2.bin"), randomBytes(1_600_000));
  git(["add", "-A"], src);
  git(["commit", "-qm", "large-fail"], src);
  g = git(["push", "-q", url, "large-fail"], src, FAIL);
  check("a push over 1 MiB whose Artifacts call fails gets a plain message, not a 500", !g.ok && /couldn't take this push right now; push again/.test(g.out) && !/HTTP 500|RPC failed/.test(g.out), g.out.split("\n").filter(Boolean).slice(0, 2).join(" | "));
  b = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/branches/large-fail`, S);
  check("and nothing was pushed", b.status === 404, `${b.status}`);

  // C2: Artifacts accepts a push but recording it fails. git still gets its report; the next branch list
  // reconciles it from Artifacts' refs: the branch row, its events and its hook delivery are written then.
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

  await new Promise((res) => receiver.listen(0, "127.0.0.1", res));

  try {
    const hook = (await call("POST", `/v1/monorepos/${O}/${M}/repos/${M}/hooks`, S, { type: "web", url: `http://127.0.0.1:${receiver.address().port}/h`, secret: "c2-secret", events: ["push"] })).json?.id;
    const RECORD_FAIL = ["-c", "http.extraHeader=X-Pando-Test-Record-Fail: 1"];
    git(["checkout", "-qb", "lost", "main"], src);
    writeFileSync(join(src, "lost.txt"), "lost\n");
    git(["add", "-A"], src);
    git(["commit", "-qm", "lost"], src);
    const lostHead = git(["rev-parse", "HEAD"], src).out.trim();
    g = git(["push", url, "lost"], src, RECORD_FAIL);
    check("a push whose record fails still tells git it landed (no error)", g.ok && !/error|rejected|failed/i.test(g.out), g.out.split("\n").filter(Boolean).slice(-2).join(" | "));
    const eventsOf = async () => ((await call("GET", `/v1/monorepos/${O}/${M}/events?since=0&limit=500`, S)).json?.events ?? []).filter((e) => e.collection === "branches" && e.row?.name === "lost");
    const deliveries = async () => ((await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/hooks/${hook}/deliveries`, S)).json?.deliveries ?? []).filter((d) => d.event === "push");
    await new Promise((res) => setTimeout(res, 1_000));
    check("and nothing was recorded yet: no event, no hook delivery", (await eventsOf()).length === 0 && (await deliveries()).length === 0 && !got.some((x) => x.body?.branch === "lost"));
    b = await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/branches?state=open`, S);
    const listed = b.json?.branches?.find((x) => x.name === "lost");
    check("the next branch list reconciles it from Artifacts' refs: the branch, at the pushed head", listed?.head === lostHead, JSON.stringify(listed?.head));
    const ev = await eventsOf();
    check("with its event (a new branch: branch.opened at the pushed head), as the pusher", ev.length === 1 && ev[0].kind === "branch.opened" && ev[0].head === lostHead && ev[0].actor === `busy-${id}`, ev.map((e) => `${e.kind}@${e.head?.slice(0, 7)}`).join(","));
    let delivered = null;

    for (let i = 0; i < 80 && !delivered; i++) {
      delivered = got.find((x) => x.event === "push" && x.body?.branch === "lost" && x.body?.head === lostHead) ?? null;

      if (!delivered) await new Promise((res) => setTimeout(res, 250));
    }

    check("and its hook delivery arrives", !!delivered, `${got.length} received`);
    await call("GET", `/v1/monorepos/${O}/${M}/repos/${M}/branches?state=open`, S);
    check("a second list writes nothing again", (await eventsOf()).length === ev.length && (await deliveries()).length === 1, `${(await eventsOf()).length} events, ${(await deliveries()).length} deliveries`);
  } finally {
    receiver.close();
  }

  // Without DOOR_TEST the headers do nothing (checked when the server runs without it).
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  if (O) {
    const r = await call("DELETE", `/v1/monorepos/${O}/${M}?confirm=${O}/${M}`, S);
    check(`delete ${O}/${M}`, r.status === 204, `${r.status}`);
  }

  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
