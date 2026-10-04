// The merge gate fails closed when pando.toml cannot be read: a read error is
// never kept as "no required checks", an unforced merge while the required
// checks are unknown is refused, and the next read tries again.
//
//   npx wrangler dev --port 8797 --persist-to <dir> --var CHECKS_TEST:1
//   PANDO_URL=http://localhost:8797 node test/checks-config.mjs
//
// Credentials stay in memory and are never printed. Git never reaches the
// macOS keychain. It deletes its monorepo.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const call = (method, path, body, secret = S) => request(URL_, method, path, { secret, body });

const work = mkdtempSync(join(tmpdir(), "pando-cc-"));

const git = (args, cwd) => {
  const r = spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S ?? "", GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" },
  });

  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
};

const commit = (dir, path, text, message) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
  git(["add", "-A"], dir);
  git(["commit", "-qm", message], dir);

  return git(["rev-parse", "HEAD"], dir).out.trim();
};

const id = Date.now().toString(36);

const O = `cc-${id}`;

const M = `cc-${id}`;

let made = false;

const tw = throwaways(async (full) => (await call("DELETE", `/v1/monorepos/${full}?confirm=${full}`)).status);

try {
  S = (await call("POST", "/v1/users", { login: O }, BOOT)).json?.credential?.secret;
  let r = await call("POST", "/v1/monorepos", { name: M });
  made = r.status === 201;

  if (made) tw.add(`${O}/${M}`);
  const MID = r.json?.monorepo?.id;
  r = await call("POST", `/v1/monorepos/${O}/${M}/repos`, { path: "projects/web" });
  const webUrl = r.json?.clone_url;
  const repo = r.json?.name;
  check("a user, a monorepo and projects/web", !!S && made && !!MID && !!webUrl, `${r.status}`);

  if (!MID || !webUrl) throw new Error("no monorepo to test with");
  const sw = await call("POST", "/v1/_checks/test", { monorepo: MID, fail: 0 }, BOOT);

  if (sw.status === 404) throw new Error("start wrangler dev with --var CHECKS_TEST:1");

  // projects/web: main and a branch, its facts settled before the config arrives.
  const web = join(work, "web");
  mkdirSync(web);
  git(["init", "-q"], web);
  commit(web, "a.txt", "a\n", "first");
  git(["push", "-q", webUrl, "main"], web);
  git(["checkout", "-qb", "feat/x"], web);
  const head = commit(web, "b.txt", "b\n", "the change");
  check("push main and feat/x", git(["push", "-q", webUrl, "feat/x"], web).ok);
  const base = `/v1/monorepos/${O}/${M}/repos/${repo}`;

  for (let i = 0; i < 100; i++) {
    const b = (await call("GET", `${base}/branches?state=open`)).json?.branches?.find((x) => x.name === "feat/x");

    if (b && b.mergeable !== "pending" && !b.stale) break;
    await sleep(200);
  }

  // The meta layer's first push brings .pando/pando.toml: projects/web requires ci/test. The kept lists are dropped.
  r = await call("GET", `/v1/monorepos/${O}/${M}/repos/meta`);
  const meta = join(work, "meta");
  mkdirSync(meta);
  git(["init", "-q"], meta);
  commit(meta, ".pando/pando.toml", '[repos."projects/web"]\nrequired_checks = ["ci/test"]\n', "Require ci/test on projects/web");
  check("the meta layer's first push brings pando.toml", git(["push", "-q", r.json?.clone_url, "main"], meta).ok);

  // pando.toml cannot be read (as when Artifacts fails): the list and the merge say so; nothing is kept as "none".
  r = await call("POST", "/v1/_checks/test", { monorepo: MID, fail: 5 }, BOOT);
  check("the test switch is on (CHECKS_TEST)", r.status === 200 && r.json?.fail === 5, JSON.stringify(r.json));
  r = await call("GET", `${base}/branches?state=open`);
  check("the branch list says the required checks could not be read", r.status === 503 && r.json?.error?.code === "checks_unknown", `${r.status} ${r.json?.error?.code}`);
  r = await call("POST", `${base}/branches/feat%2Fx/merge`, { expected_head: head });
  check(
    "an unforced merge while the required checks are unknown is refused, plainly",
    r.status === 503 && r.json?.error?.code === "checks_unknown" && /couldn't read this monorepo's required checks; try again/.test(r.json?.error?.message ?? ""),
    `${r.status} ${r.json?.error?.code}: ${r.json?.error?.message}`,
  );

  // The read recovers: the next one reads the file, so the gate holds for the missing ci/test.
  await call("POST", "/v1/_checks/test", { monorepo: MID, fail: 0 }, BOOT);
  r = await call("POST", `${base}/branches/feat%2Fx/merge`, { expected_head: head });
  check("once the read recovers, the merge waits for ci/test (nothing was kept as no checks)", r.status === 412 && r.json?.error?.code === "checks_not_green" && r.json?.error?.checks?.missing?.[0] === "ci/test", `${r.status} ${r.json?.error?.code} missing ${JSON.stringify(r.json?.error?.checks?.missing)}`);
  r = await call("GET", base);
  check("the repo lists ci/test as required", JSON.stringify(r.json?.required_checks) === '["ci/test"]', JSON.stringify(r.json?.required_checks));
  r = await call("POST", `${base}/statuses/${head}`, { context: "ci/test", state: "success" });
  check("ci/test reports success", r.status === 201, `${r.status}`);
  r = await call("POST", `${base}/branches/feat%2Fx/merge`, { expected_head: head });
  check("then the merge goes through, not forced", r.status === 200 && r.json?.status === "merged" && r.json?.forced === false, `${r.status} ${r.json?.status ?? r.json?.error?.code}`);
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  if (made) check(`delete ${O}/${M}`, await tw.cleanup());
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
