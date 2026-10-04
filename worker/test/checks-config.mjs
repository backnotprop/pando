// The merge gate fails closed when pando.toml cannot be read or does not
// parse: neither is kept as "no required checks", an unforced merge while the
// required checks are unknown is refused, and the next read tries again.
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

  // Reads answer as usual while the required checks are unknown: the list null, checks unknown, and why.
  const unknownReads = async (why) => {
    const list = await call("GET", `${base}/branches?state=open`);
    const row = list.json?.branches?.find((x) => x.name === "feat/x" || x.name === "feat/y");
    const one = await call("GET", `${base}/branches/${encodeURIComponent(row?.name ?? "feat/x")}`);
    const status = await call("GET", `${base}/commits/${row?.head}/status`);
    const repoRead = await call("GET", base);
    const unknown = (c) => c?.state === "unknown" && c?.required === null && why.test(c?.checks_unknown ?? "");

    return {
      ok: list.status === 200 && unknown(row?.checks) && one.status === 200 && unknown(one.json?.checks) && status.status === 200 && unknown(status.json) &&
        repoRead.status === 200 && repoRead.json?.required_checks === null && why.test(repoRead.json?.checks_unknown ?? ""),
      detail: `${list.status} ${one.status} ${status.status} ${repoRead.status}: ${row?.checks?.state} ${JSON.stringify(row?.checks?.required)} "${row?.checks?.checks_unknown}"`,
    };
  };

  // pando.toml cannot be read (as when Artifacts fails): reads say so, the merge refuses; nothing is kept as "none".
  r = await call("POST", "/v1/_checks/test", { monorepo: MID, fail: 50 }, BOOT);
  check("the test switch is on (CHECKS_TEST)", r.status === 200 && r.json?.fail === 50, JSON.stringify(r.json));
  const failing = await unknownReads(/couldn't read this monorepo's required checks; try again/);
  check("the branch list, the branch, its status and the repo answer 200 with required null and the reason", failing.ok, failing.detail);
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

  // A pando.toml that does not parse: unknown too, said with its line, until a fix is merged.
  const metaUrl = (await call("GET", `/v1/monorepos/${O}/${M}/repos/meta`)).json?.clone_url;
  const metaBase = `/v1/monorepos/${O}/${M}/repos/meta`;
  git(["checkout", "-qb", "break"], meta);
  commit(meta, ".pando/pando.toml", '[repos."projects/web"]\nrequired_checks = ["ci/test"\n', "Break pando.toml");
  git(["push", "-q", metaUrl, "break"], meta);
  r = await call("POST", `${metaBase}/branches/break/merge`);
  check("a broken pando.toml merges into the meta layer (it was fine until then)", r.status === 200 && r.json?.status === "merged", `${r.status} ${r.json?.error?.code ?? ""}`);
  git(["checkout", "-qb", "feat/y", "main"], web);
  const headY = commit(web, "y.txt", "y\n", "another change");
  git(["push", "-q", webUrl, "feat/y"], web);
  await call("POST", `${base}/statuses/${headY}`, { context: "ci/test", state: "success" });
  r = await call("POST", `${base}/branches/feat%2Fy/merge`, { expected_head: headY });
  check(
    "with pando.toml invalid, an unforced merge is refused and says which line",
    r.status === 503 && r.json?.error?.code === "checks_unknown" && /^pando\.toml line \d+: .+; fix it on main, or merge with force$/.test(r.json?.error?.message ?? ""),
    `${r.status} ${r.json?.error?.code}: ${r.json?.error?.message}`,
  );
  const broken = await unknownReads(/^pando\.toml line \d+: .+; fix it on main, or merge with force$/);
  check("reads answer 200 with required null and the file's line", broken.ok, broken.detail);
  git(["checkout", "-q", "break"], meta);
  commit(meta, ".pando/pando.toml", '[repos."projects/web"]\nrequired_checks = ["ci/test"]\n', "Fix pando.toml");
  git(["push", "-q", metaUrl, "break:fix"], meta);
  r = await call("GET", `${metaBase}/branches?state=open`);
  const fixRow = r.json?.branches?.find((x) => x.name === "fix");
  check("the meta layer's branch list shows the fix, its checks unknown", r.status === 200 && fixRow?.checks?.state === "unknown" && fixRow.checks.required === null, `${r.status} ${fixRow?.checks?.state}`);
  r = await call("POST", `${metaBase}/branches/fix/merge`);
  check("the fix's own merge is refused the same way (the meta layer's checks are unknown too)", r.status === 503 && r.json?.error?.code === "checks_unknown", `${r.status} ${r.json?.error?.code}`);
  r = await call("POST", `${metaBase}/branches/fix/merge?force=1`);
  check("merged with force, it goes through and is recorded as forced", r.status === 200 && r.json?.status === "merged" && r.json?.forced === true, `${r.status} ${r.json?.status ?? r.json?.error?.code} forced ${r.json?.forced}`);
  r = await call("POST", `${base}/branches/feat%2Fy/merge`, { expected_head: headY });
  check("with pando.toml fixed, the merge goes through, not forced", r.status === 200 && r.json?.status === "merged" && r.json?.forced === false, `${r.status} ${r.json?.status ?? r.json?.error?.code}`);
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  if (made) check(`delete ${O}/${M}`, await tw.cleanup());
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
