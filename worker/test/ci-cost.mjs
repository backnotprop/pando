// CI costs, end to end against `wrangler dev` (owner, 2026-10-13: "what if an
// agent pushes 1000 times a day?"), with a local stand-in for Buildkite's REST
// API (create-build and cancel):
//   1. a newer push to a branch cancels the build of its old head, whose
//      Buildkite checks read superseded (not failed); a build that finished
//      first keeps its result; main's builds are never cancelled;
//   2. with a CI connection, the build's row says "superseded by <sha>" and
//      its cancelled job's check reads superseded;
//   3. the repo's "when checks run" setting (PATCH .../repos/{r} ci_policy):
//      on_merge builds nothing on push, starts one build when a merge asks
//      (the body the agents' merge tool sends), waits for green, and lands;
//      main_only builds branches never and main's merge commit as before.
//
//   PANDO_URL=http://localhost:8917 node test/ci-cost.mjs
//
// It writes its real answers for the contract's check (packages/contract/recorded/).
//
// Reads PANDO_BOOTSTRAP and BUILDKITE_API_TOKEN from worker/.dev.vars; never prints them.
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError, retryResetFetch } from "./errors.mjs";
import { request } from "./http.mjs";

retryResetFetch();

const URL_ = (process.env.PANDO_URL ?? "http://localhost:8917").replace(/\/$/, "");

const VARS = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");

const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(VARS)?.[1];

const BK_TOKEN = /^BUILDKITE_API_TOKEN=(.*)$/m.exec(VARS)?.[1];

const scrub = (s) =>
  String(s)
    .replace(/art_v\d+_[A-Za-z0-9]+(\?expires=\d+)?/g, "<token>")
    .replace(/pst1\.[A-Za-z0-9_.-]+/g, "<status-token>")
    .replace(/pando_[a-f0-9]{20,}/g, "<credential>");

const RECORDED = new URL("../../packages/contract/recorded/", import.meta.url);

/** A real answer, for the contract's check (packages/contract/scripts/check-recorded.ts). */
const record = (file, schema, route, status, body) => writeFileSync(new URL(file, RECORDED), `${scrub(JSON.stringify({ schema, route, status, body }, null, 2))}\n`);

const results = [];

const check = (name, ok, detail = "") => {
  results.push(!!ok);
  console.log(scrub(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`));
};

const call = (method, path, secret, body, headers = {}) => request(URL_, method, path, { secret, body, headers, redirect: "manual" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (pred, ms = 30_000) => {
  const end = Date.now() + ms;

  while (Date.now() < end) {
    const v = await pred();

    if (v) return v;
    await sleep(250);
  }

  return null;
};

// ── the Buildkite stand-in: create-build answers a numbered build, cancel cancels one still going ──
const bk = { builds: [], calls: [], badAuth: 0, next: 1 };

const GOING = new Set(["scheduled", "running", "failing"]);

const bkBuild = (b) => ({
  id: `bld-${b.number}`, number: b.number, state: b.state, commit: b.commit, branch: b.branch, message: b.message, meta_data: b.meta_data ?? {},
  url: `https://api.buildkite.com/v2/organizations/o/pipelines/p/builds/${b.number}`, web_url: `https://buildkite.com/o/p/builds/${b.number}`,
  created_at: b.created_at, started_at: null, finished_at: null,
});

const bkPipeline = { id: "pl-p", slug: "p", name: "p", url: "https://api.buildkite.com/v2/organizations/o/pipelines/p", web_url: "https://buildkite.com/o/p", default_branch: "main" };

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const path = new URL(req.url, "http://x").pathname;
    bk.calls.push(`${req.method} ${path}`);

    if (req.headers.authorization !== `Bearer ${BK_TOKEN}`) bk.badAuth++;
    const json = (code, v) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(v));
    let m;

    if (path === "/v2/organizations/o/pipelines/p/builds" && req.method === "POST") {
      const body = JSON.parse(raw);
      const b = { number: bk.next++, state: "scheduled", commit: body.commit, branch: body.branch, message: body.message, meta_data: body.meta_data, env: body.env, created_at: new Date().toISOString() };
      bk.builds.push(b);

      return json(201, { ...bkBuild(b), pipeline: bkPipeline });
    }

    if ((m = /^\/v2\/organizations\/o\/pipelines\/p\/builds\/(\d+)\/cancel$/.exec(path)) && req.method === "PUT") {
      const b = bk.builds.find((x) => x.number === Number(m[1]));

      if (!b) return json(404, { message: "Not Found" });

      // Buildkite cancels a build that is scheduled, running or failing; any other is 422.
      if (!GOING.has(b.state)) return json(422, { message: "Build can't be canceled because it's already finished" });
      b.state = "canceled";

      return json(200, { ...bkBuild({ ...b, state: "canceling" }), pipeline: bkPipeline });
    }

    json(404, { message: "Not Found" });
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));

const port = server.address().port;

const builtFor = (sha) => bk.builds.filter((b) => b.commit === sha);

const cancelled = (n) => bk.calls.includes(`PUT /v2/organizations/o/pipelines/p/builds/${n}/cancel`);

const id = Date.now().toString(36);

const work = mkdtempSync(join(tmpdir(), "pando-ci-cost-"));

const M = `cost-${id}`;

let O = null;

let S = null;

let made = false;

try {
  S = (await call("POST", "/v1/users", BOOT, { login: `cost-${id}` })).json?.credential?.secret;
  const B = (await call("POST", "/v1/users", BOOT, { login: `costm-${id}` })).json?.credential?.secret;
  let r = await call("POST", "/v1/monorepos", S, { name: M, kind: "repo" });
  O = r.json?.monorepo?.owner ?? null;
  made = r.status === 201;
  const url = r.json?.repos?.[0]?.clone_url;
  const base = `/v1/monorepos/${O}/${M}/repos/${M}`;
  r = await call("PUT", `/v1/monorepos/${O}/${M}/members/costm-${id}`, S, { role: "member" });
  check("a plain repo, its owner and a member", made && !!url && r.status === 200);
  r = await call("POST", `${base}/hooks`, S, { type: "buildkite", buildkite: { organization: "o", pipeline: "p", api_url: `http://127.0.0.1:${port}/v2/organizations/o/pipelines/p/builds` } });
  check("a buildkite hook (pushes and merges), at the stand-in", r.status === 201 && r.json?.events?.join() === "push,merged");

  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: work, XDG_CONFIG_HOME: join(work, ".config"), GIT_TERMINAL_PROMPT: "0", PANDO_SECRET: S, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@pando.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@pando.invalid" };
  const git = (a) => spawnSync("git", ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x; echo "password=$PANDO_SECRET"; }; f', "-c", "init.defaultBranch=main", ...a], { cwd: src, env, encoding: "utf8" });
  const src = join(work, "src");
  mkdirSync(join(src, ".pando"), { recursive: true });
  git(["init", "-q"]);
  writeFileSync(join(src, ".pando", "pando.toml"), '[repos."."]\nrequired_checks = ["ci"]\n');
  writeFileSync(join(src, "f"), "0\n");
  let n = 0;

  /** A new commit on `branch` (made from main when new), pushed: its sha. */
  const pushTo = (branch, from = null) => {
    if (from) git(["checkout", "-qB", branch, from]);
    else git(["checkout", "-q", branch]);
    writeFileSync(join(src, "f"), `${++n}\n`);
    git(["commit", "-qam", `${branch} ${n}`]);
    const p = git(["push", "-q", url, branch]);

    if (p.status !== 0) throw new Error(`push ${branch}: ${scrub(p.stderr)}`);

    return git(["rev-parse", "HEAD"]).stdout.trim();
  };

  git(["add", "-A"]);
  git(["commit", "-qm", "first"]);
  check("main pushed, requiring the check ci", git(["push", "-q", url, "main"]).status === 0);
  const main1 = git(["rev-parse", "HEAD"]).stdout.trim();
  check("main's push builds", !!(await waitFor(() => builtFor(main1)[0])));

  const statusPath = (sha) => `${base}/statuses/${sha}`;
  const checksOf = async (sha) => (await call("GET", `${base}/commits/${sha}/status`, S)).json;
  const ciOf = async (sha) => (await checksOf(sha))?.statuses?.find((s) => s.context === "ci");
  /** The check ci, posted as the build itself would (its status token: app buildkite). */
  const report = (b, state) => call("POST", statusPath(b.commit), b.env?.PANDO_STATUS_TOKEN, { state, context: "ci", target_url: `https://buildkite.com/o/p/builds/${b.number}` });

  // ── 1. Every push (the default): a newer push cancels the old head's build ──
  const head1 = pushTo("feat", "main");
  const b1 = await waitFor(() => builtFor(head1)[0]);
  r = await report(b1, "pending");
  check("feat's first push builds (#2); the build reports ci pending", !!b1 && r.status === 201 && r.json?.app === "buildkite");
  const head2 = pushTo("feat");
  const b2 = await waitFor(() => builtFor(head2)[0]);
  check("a second push: Buildkite is asked to cancel the first build", !!(await waitFor(() => cancelled(b1.number))) && b1.state === "canceled");
  check("and the second head builds as before", !!b2 && b2.branch === "feat");

  const sup = await waitFor(async () => {
    const s = await ciOf(head1);

    return s?.state === "superseded" && s;
  });

  check("the first head's check ci reads superseded, not failed: '#2 superseded by <sha>', still Buildkite's", sup?.description === `#${b1.number} superseded by ${head2.slice(0, 7)}` && sup.app === "buildkite", JSON.stringify(sup?.description));
  const c1 = await checksOf(head1);

  record("status-superseded.json", "Checks", "GET .../repos/{repo}/commits/{ref}/status (its build cancelled for a newer push: superseded, so missing)", 200, c1);
  check("a superseded required check counts as not reported: the gate says missing", c1?.state === "missing" && c1.missing?.includes("ci"), c1?.state);
  r = await call("POST", statusPath(head1), S, { state: "superseded", context: "x" });
  check("no one posts superseded (Pando's own state): 400", r.status === 400);

  // A build that finished before the next push keeps its result.
  b2.state = "passed";
  await report(b2, "success");
  const head3 = pushTo("feat");
  const b3 = await waitFor(() => builtFor(head3)[0]);
  await waitFor(() => cancelled(b2.number));
  await sleep(1000);
  check("a build that had finished: Buildkite answers 422, and its check stays success", !!b3 && cancelled(b2.number) && (await ciOf(head2))?.state === "success");

  // Main's builds are never cancelled: the merge commit's, then a push to main.
  b3.state = "passed";
  await report(b3, "success");
  r = await call("POST", `${base}/branches/feat/merge`, S, {});
  const mergeSha = r.json?.sha;
  const bm = await waitFor(() => builtFor(mergeSha ?? "-")[0]);
  check("feat merges when green; main's merge commit builds on main", r.status === 200 && bm?.branch === "main", `${r.status} ${r.json?.error?.message ?? ""}`);
  git(["checkout", "-q", "main"]);
  git(["pull", "-q", url, "main"]);

  // ── 2. With a CI connection: the build's row and its job's check ──
  r = await call("POST", `/v1/monorepos/${O}/${M}/ci/connections`, S, { service: "buildkite", organization: "o", api_url: `http://127.0.0.1:${port}` });
  const conn = r.json?.connection;
  const WH = r.json?.webhook_token;
  check("Buildkite connected (webhooks)", r.status === 201 && !!WH);

  const send = (event, payload) => {
    const body = JSON.stringify({ event, ...payload });
    const ts = Math.floor(Date.now() / 1000);
    const headers = { "x-buildkite-event": event, "x-buildkite-signature": `timestamp=${ts},signature=${createHmac("sha256", WH).update(`${ts}.${body}`).digest("hex")}` };

    return request(URL_, "POST", `/v1/integrations/buildkite/${conn.id}`, { raw: body, headers });
  };

  const job = (id_, state) => ({ id: id_, type: "script", name: "test", step_key: "ci", state, web_url: `https://buildkite.com/o/p/builds/x#${id_}`, soft_failed: false, exit_status: state === "canceled" ? -1 : null, created_at: new Date().toISOString(), started_at: null, finished_at: null, retried: false });
  const headW1 = pushTo("wh", "main");
  const bw = await waitFor(() => builtFor(headW1)[0]);
  bw.state = "running";
  r = await send("build.running", { build: bkBuild(bw), pipeline: bkPipeline });
  const rowId = r.json?.build;
  await send("job.started", { build: bkBuild(bw), pipeline: bkPipeline, job: job("job-w1", "running") });
  check("its build is recorded from the webhook and its job reports ci pending", (rowId ?? "").startsWith("cib_") && (await ciOf(headW1))?.state === "pending");
  const headW2 = pushTo("wh");
  await waitFor(() => cancelled(bw.number));

  const row = await waitFor(async () => {
    const b = (await call("GET", `/v1/monorepos/${O}/${M}/ci/builds/${rowId}`, B)).json;

    return b?.superseded_by && b;
  });

  check("the build's row: superseded by the new head (the CI page shows it)", row?.superseded_by === headW2, row?.superseded_by);
  record("ci-build-superseded.json", "CiBuildDetail", "GET .../ci/builds/{build} (cancelled for a newer push: superseded_by)", 200, row);
  bw.state = "canceled";
  await send("job.finished", { build: bkBuild({ ...bw, state: "canceling" }), pipeline: bkPipeline, job: job("job-w1", "canceled") });
  await send("build.finished", { build: bkBuild(bw), pipeline: bkPipeline });
  const sw = await ciOf(headW1);
  check("its job's cancel reads superseded, not '#N canceled'", sw?.state === "superseded" && sw.description === `#${bw.number} superseded by ${headW2.slice(0, 7)}`, `${sw?.state} ${sw?.description}`);
  r = await call("GET", `/v1/monorepos/${O}/${M}/ci/builds?sha=${headW1}`, B);
  check("the builds list carries superseded_by", r.json?.builds?.[0]?.superseded_by === headW2 && r.json.builds[0].state === "canceled");
  r = await call("DELETE", `/v1/monorepos/${O}/${M}/ci/connections/${conn.id}`, S);

  // ── 3. When checks run: on_merge ──
  r = await call("GET", base, B);
  check("a repo's ci_policy reads every_push by default", r.json?.ci_policy === "every_push");
  r = await call("PATCH", base, B, { ci_policy: "on_merge" });
  check("a member cannot change it: 403", r.status === 403);
  r = await call("PATCH", base, S, { ci_policy: "sometimes" });
  check("an unknown policy: 400", r.status === 400);
  r = await call("PATCH", base, S, { ci_policy: "on_merge" });
  check("an owner sets on_merge", r.status === 200 && r.json?.ci_policy === "on_merge" && r.json.releases_public === false);
  record("repo-ci-policy.json", "Repo", "PATCH .../repos/{repo} {ci_policy: on_merge}", r.status, r.json);
  r = await call("GET", `/v1/monorepos/${O}/${M}/repos`, B);
  check("the repo list says so too", r.json?.repos?.[0]?.ci_policy === "on_merge");
  record("repos-ci-policy.json", "RepoList", "GET .../repos (each with its ci_policy)", r.status, r.json);

  const before = bk.builds.length;
  const headO1 = pushTo("om", "main");
  await sleep(3000);
  check("on_merge: a push starts no build", bk.builds.length === before && builtFor(headO1).length === 0);
  // The agents' merge tool sends "{}": the same route and body.
  r = await call("POST", `${base}/branches/om/merge`, S, {});
  record("merge-checks-started.json", "ErrorBody", "POST .../branches/{branch}/merge (on_merge: 412 checks_not_green, checks_started)", r.status, r.json);
  check("the first merge: 412 checks_not_green, checks_started, in words", r.status === 412 && r.json?.error?.code === "checks_not_green" && r.json.error.checks_started === true && /checks started for this merge/.test(r.json.error.message), r.json?.error?.message);
  const bo1 = await waitFor(() => builtFor(headO1)[0]);
  check("and one build of the branch's head, for the merge", !!bo1 && bo1.branch === "om" && bo1.message.startsWith("Checks for merging om"), bo1?.message);
  r = await call("POST", `${base}/branches/om/merge`, S, {});
  await sleep(1000);
  check("merging again while it runs: 412 checks_not_green, no second build", r.status === 412 && !r.json?.error?.checks_started && builtFor(headO1).length === 1);
  const headO2 = pushTo("om");
  const bo2 = await waitFor(() => builtFor(headO2)[0]);
  check("a push while the merge waits: the merge's build is cancelled and the new head builds", !!(await waitFor(() => cancelled(bo1.number))) && !!bo2 && bo2.message.startsWith("Checks for merging om"));
  await report(bo2, "pending");
  r = await call("POST", `${base}/branches/om/merge`, S, {});
  check("pending: the merge waits (412)", r.status === 412 && r.json?.error?.checks?.state === "pending");
  await report(bo2, "success");
  r = await call("POST", `${base}/branches/om/merge`, S, {});
  check("green: the merge lands", r.status === 200 && r.json?.status === "merged", r.json?.error?.message);
  check("main's merge commit builds as before", !!(await waitFor(() => builtFor(r.json?.sha ?? "-")[0])));
  git(["checkout", "-q", "main"]);
  git(["pull", "-q", url, "main"]);
  const quiet = bk.builds.length;
  pushTo("quiet", "main");
  pushTo("quiet");
  await sleep(3000);
  check("two pushes to a branch no one merges: no build at all", bk.builds.length === quiet);

  // ── main_only ──
  r = await call("PATCH", base, S, { ci_policy: "main_only" });
  check("an owner sets main_only", r.status === 200 && r.json?.ci_policy === "main_only");
  const headM = pushTo("mo", "main");
  r = await call("POST", `${base}/branches/mo/merge`, S, {});
  await sleep(3000);
  check("main_only: no branch build on push or merge (412, nothing started)", builtFor(headM).length === 0 && r.status === 412 && !r.json?.error?.checks_started);
  r = await call("POST", `${base}/branches/mo/merge?force=1`, S, {});
  check("a forced merge lands, and main's merge commit builds", r.status === 200 && !!(await waitFor(() => builtFor(r.json?.sha ?? "-")[0])));
  r = await call("PATCH", base, S, {});
  check("PATCH with nothing to set: 400", r.status === 400);
  check("main's first merge commit build, still running after two more merges, was never cancelled", bm?.state === "scheduled" && !cancelled(bm?.number));
  check("every call to the stand-in carried BUILDKITE_API_TOKEN", bk.calls.length > 0 && bk.badAuth === 0, `${bk.calls.length} calls`);
} catch (err) {
  check("no exception", false, describeError(err));
} finally {
  if (made) {
    const r = await call("DELETE", `/v1/monorepos/${O}/${M}?confirm=${O}/${M}`, S);
    check(`delete ${M}`, r.status === 204);
  }

  server.close();
  rmSync(work, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
