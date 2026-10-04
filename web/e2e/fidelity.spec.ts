// Fidelity shots, not assertions: the design (v3/prototype.html) is the bar.
// It makes a monorepo shaped like the prototype's (ramos/pando, its root files,
// two projects, branches that are ready, conflicting and failing, a second
// member, machines connected with their worktrees, Buildkite connected through
// a stand-in with the prototype's builds), then shoots each screen next to the
// prototype's own route, at the prototype's settings (2x, dark, reduced motion,
// 1.5 s after load), into e2e/shots/.
//
//   npm run shots                       (the Worker with this worktree's own state; the persona `ramos` is local to it)
//   PANDO_SHOTS=mono-,ci- npm run shots (only the pairs whose names start so)
import { type Browser, expect, type Locator, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Buildkite } from "./buildkite";
import { BASE, browserPost, ciStatus, Machine, nextSignIn, saveRootFiles } from "./seed";

const PROTOTYPE = pathToFileURL(fileURLToPath(new URL("../../../../../../research/design/pando-ui-2026-10-03/v3/prototype.html", import.meta.url))).href;

const SHOTS = fileURLToPath(new URL("shots/", import.meta.url));

const ramos = { id: "user_ramos_local", email: "ramos@pando.invalid", email_verified: true, first_name: "Michael", last_name: "Ramos" };

// The prototype's second person: a member of ramos/pando, on her own machine.
const ana = { id: "user_ana_local", email: "ana@pando.invalid", email_verified: true, first_name: "Ana", last_name: "Lopes" };

// Required checks, as the prototype's pipelines show them (read from the root's .pando/pando.toml).
const PANDO_TOML = '[repos."projects/pando"]\nrequired_checks = ["ci"]\n\n[repos."projects/artifact-fs"]\nrequired_checks = ["e2e-linux"]\n';

const WORKSPACES_TOML = '[repos."projects/workspaces"]\nrequired_checks = ["ci", "e2e"]\n';

const AGENTS = `You are in Pando's monorepo.

# What this place is

Pando is a git platform for monorepos, built on Cloudflare Workers and
Artifacts, for many agents working at once.

This folder is Pando's own monorepo, in the shape Pando hosts:

- **Code repos live under \`projects/<repo>/\`**, each its own git repo, with
  its branches checked out at \`projects/<repo>/worktrees/<name>/\`.

Lead coordinator: the \`pando-ops\` session. Handoff history:
\`research/handoffs/HANDOFF-pando-2026-10-02.md\`.

# Map

\`\`\`
pando/
  AGENTS.md                      this file
  decisions/RULINGS.md           the owner's rulings in force (current truth)
  backlog/active-checklist.md    open items, newest last
  research/
    plans/                       the proposal rounds
    handoffs/                    handoffs between sessions
  projects/
    pando/worktrees/main/        Pando's code
    artifact-fs/worktrees/main/  the mount daemon
\`\`\`

# Worktrees (required for parallel work)

- \`projects/<repo>/worktrees/main/\` is the integration checkout. Only the
  coordinator merges there.
- Every lane gets its own worktree as a sibling of \`main/\`.
- One branch, one worktree, one agent.
`;

// A code file with every syntax role (comment, keyword, string, function, constant), for the theme shots.
const INDEX_TS = `// The Pando Worker: the one way in.
import { credential, HttpError } from "./http";
import { monorepoStub } from "./monorepo/stub";

const MAX_BODY = 64 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") return new Response("ok");

    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) {
      throw new HttpError(413, \`bodies stop at \${MAX_BODY} bytes\`);
    }

    const who = await credential(request, env);

    return monorepoStub(env, who).fetch(request);
  },
};
`;

// web-api's edit to it and its new file, so the branch's Files changed shows additions, deletions and every syntax role.
const INDEX_TS_WEB_API = INDEX_TS.replace('import { monorepoStub } from "./monorepo/stub";', 'import { gitwrite } from "./gitwrite";\nimport { monorepoStub } from "./monorepo/stub";')
  .replace("const MAX_BODY = 64 * 1024 * 1024;", "// git packs up to 128 MiB.\nconst MAX_BODY = 128 * 1024 * 1024;")
  .replace("return monorepoStub(env, who).fetch(request);", "return gitwrite(monorepoStub(env, who), request);");

const GITWRITE_TS = `// gitwrite: a push with the object's cached write token, no mint per push.
const TOKEN_TTL_S = 300;

export async function gitwrite(stub: MonorepoStub, request: Request): Promise<Response> {
  const token = await stub.writeToken(TOKEN_TTL_S);

  return stub.fetch(new Request(request, { headers: { authorization: \`Bearer \${token}\` } }));
}
`;

const RULINGS = `# Pando: the owner's rulings in force

Current truth only, revised in place when a ruling changes. History is in \`research/operational/deviations/\`. Last revised 2026-10-03.

## Shape

- **One monorepo per project.** Decisions, research and boards are plain files that every machine receives live. Code repos sit under \`projects/<repo>/\`, each a protected git repo.
- **Defaults, not configuration.** With no config file, every folder under \`projects/\` is a repo, its branches mount at \`projects/<repo>/worktrees/<branch>/\`, and \`worktrees/main\` is main, read-only.
- **Large files and binaries go to R2**, not the repo.

## Commits, review, merge

- **Commits keep their messages**; Pando adds who made each commit as trailers. Agents commit, amend and rebase their branches; Pando refuses only pushes to main.
- **Merging works like \`gh\`:** any member's credential can merge through the API or the CLI, agents included; checks must be green unless forced.
- **Anyone who may merge may force past red or missing checks.** Governance later.

## Web app

- **The web home is account-level and technical**, like GitHub's home or an organization page: the person's monorepos, most recently active first, and an activity log across all of them.
- **Meta files in the web are read-only at launch**; editing comes after.
`;

interface Showcase {
  machine: Machine;
  sandbox: Machine;
  /** The machines' open sockets (connected on the Machines tab), and the stand-in Buildkites, closed after the shots. */
  sockets: WebSocket[];
  buildkites: Buildkite[];
  /** The running ci job of build #1288, whose log a shot opens. */
  runningJob: string;
}

async function remake(page: Page, m: Machine, name: string, kind: "monorepo" | "repo") {
  await m.api("DELETE", `/v1/monorepos/ramos/${name}?confirm=ramos/${name}`);
  await browserPost(page, "/v1/monorepos", { name, kind });
}

async function project(page: Page, mono: string, path: string): Promise<string> {
  return (await browserPost(page, `/v1/monorepos/ramos/${mono}/repos`, { path })).clone_url;
}

/** One commit on a branch of a project, pushed by `m`; returns the commit's sha. */
function pushBranch(m: Machine, repo: string, url: string, branch: string, files: Record<string, string>, title: string): string {
  const dir = m.commit(repo, url, branch, files, title);
  m.push(dir, url, branch);

  return m.git(dir, "rev-parse", "HEAD").trim();
}

/** A branch's title, as `pando` sets it (the pull request's title). */
async function title(m: Machine, full: string, repo: string, branch: string, text: string) {
  await m.api("PATCH", `/v1/monorepos/${full}/repos/${repo}/branches/${branch}`, { title: text });
}

/**
 * The root's .pando/pando.toml, as the meta layer's first push (a save there
 * is refused: .pando/ changes only through git), before any root file is
 * saved or any project reads its required checks.
 */
function requireChecks(m: Machine, full: string, toml: string) {
  const url = `${BASE}/${full}/meta.git`;

  m.push(m.commit(`meta-${full.replace("/", "-")}`, url, "main", { ".pando/pando.toml": toml }, "Require checks"), url, "main");
}

/** Ana signs in once, in her own browser, and makes her machine's credential. */
async function anaMachine(browser: Browser): Promise<Machine> {
  const hers = await browser.newContext();
  const p = await hers.newPage();

  await nextSignIn(ana);
  await p.goto(`${BASE}/login`);
  await p.getByRole("link", { name: "Sign in" }).click();
  await expect(p).toHaveURL(`${BASE}/`);
  const m = await Machine.make(p, "ana-mbp", "ana");

  await hers.close();

  return m;
}

/** A worktree a machine reports (pando worktree add), before it pushes, so its pushes are its latest activity. */
const worktree = (m: Machine, full: string, id: string, repo: string, branch: string, kind: "fuse" | "fskit" = "fuse") =>
  m.api("PUT", `/v1/monorepos/${full}/worktrees/${id}`, { repo, branch, path: `${repo}/worktrees/${branch}`, machine: m.name, kind });

async function seed(page: Page, browser: Browser): Promise<Showcase> {
  const machine = await Machine.make(page, "ramos-mbp", "ramos");
  const sandbox = await Machine.make(page, "sandbox-1", "ramos", "sandbox");
  const sandbox2 = await Machine.make(page, "sandbox-2", "ramos", "sandbox");
  const sandbox3 = await Machine.make(page, "sandbox-3", "ramos", "sandbox");
  const anaMbp = await anaMachine(browser);
  await remake(page, machine, "pando-brand", "repo");
  await remake(page, machine, "workspaces", "monorepo");
  await remake(page, machine, "pando", "monorepo");

  const brand = (await (await machine.api("GET", "/v1/monorepos/ramos/pando-brand/repos")).json()).repos[0].clone_url;
  pushBranch(machine, "brand", brand, "main", { "README.md": "# pando-brand\n" }, "The 01E2 Daylight card");

  requireChecks(machine, "ramos/workspaces", WORKSPACES_TOML);
  const ws = await project(page, "workspaces", "projects/workspaces");
  const wsCli = await project(page, "workspaces", "projects/workspaces-cli");
  await worktree(sandbox, "ramos/workspaces", "wt-search-index", "projects/workspaces", "search-index");
  await worktree(machine, "ramos/workspaces", "wt-decision-chips", "projects/workspaces", "decision-chips");
  await saveRootFiles(page, "ramos/workspaces", "ramos-mbp", { "AGENTS.md": "# Workspaces\n\nThe monorepo for Workspaces.\n" });
  const wsMain = pushBranch(machine, "workspaces", ws, "main", { "README.md": "# workspaces\n" }, "Merge callout-seam: callouts keep their seam on narrow cards");
  pushBranch(machine, "workspaces-cli", wsCli, "main", { "README.md": "# workspaces-cli\n" }, "Merge release-0.9: the 0.9 notes");
  pushBranch(sandbox, "workspaces", ws, "search-index", { "search.ts": "export {};\n" }, "search: index customer-docs on every save\n\nCo-authored-by: Claude <noreply@anthropic.com>");
  const failing = pushBranch(sandbox, "workspaces", ws, "search-index", { "rank.test.ts": "export {};\n" }, "search: a ranking test for exact names");

  await title(machine, "ramos/workspaces", "projects-workspaces", "search-index", "Index customer docs for search");
  await ciStatus(machine, "ramos/workspaces", "projects-workspaces", failing, "ci", "success");
  await ciStatus(machine, "ramos/workspaces", "projects-workspaces", failing, "e2e", "failure");

  requireChecks(machine, "ramos/pando", PANDO_TOML);
  await browserPost(page, "/v1/monorepos/ramos/pando/invites", { email: ana.email, role: "member" });
  await browserPost(page, "/v1/monorepos/ramos/pando/invites", { email: "ben@example.com", role: "member" });
  const pando = await project(page, "pando", "projects/pando");
  const fs = await project(page, "pando", "projects/artifact-fs");
  await worktree(anaMbp, "ramos/pando", "wt-live", "projects/pando", "live", "fskit");
  await worktree(machine, "ramos/pando", "wt-cli", "projects/pando", "cli", "fskit");
  await worktree(machine, "ramos/pando", "wt-mac-mount", "projects/pando", "mac-mount", "fskit");
  await worktree(sandbox, "ramos/pando", "wt-web-api", "projects/pando", "web-api");
  await worktree(sandbox2, "ramos/pando", "wt-fs-mac-mount", "projects/artifact-fs", "mac-mount");
  // A sandbox that reported a worktree once and has not connected since (the Machines tab's offline row).
  await worktree(sandbox3, "ramos/pando", "wt-scale-audit", "projects/pando", "scale-audit");
  await saveRootFiles(page, "ramos/pando", "ramos-mbp", [
    ["backlog/active-checklist.md", "# Pando board\n\nOpen items only, newest last.\n"],
    ["backlog/active-checklist-archive-2026-10-03.md", "# Archive\n"],
    ["decisions/RULINGS.md", RULINGS.split("\n## Commits")[0] ?? RULINGS],
    ["decisions/RULINGS.md", RULINGS.split("\n## Web app")[0] ?? RULINGS],
    ["decisions/RULINGS.md", RULINGS],
    ["research/handoffs/HANDOFF-pando-2026-10-02.md", "# Handoff\n"],
    ["AGENTS.md", AGENTS],
    ["research/plans/architecture-2026-10-03/NAMESPACES.md", "# Namespaces\n"],
  ]);
  // Saved from a sandbox that has since gone offline (the Machines tab's last row).
  await saveRootFiles(page, "ramos/pando", "sandbox-3", { "research/plans/architecture-2026-10-03/SCALE-AUDIT.md": "# Scale audit\n" });
  pushBranch(
    machine,
    "pando",
    pando,
    "main",
    {
      "README.md": "# Pando\n\nA git platform for monorepos, built on Cloudflare Workers and Artifacts, for many agents working at once.\n",
      ".gitignore": "node_modules/\n",
      LICENSE: "Apache License 2.0\n",
      "REFERENCES.md": "# References\n",
      "cli/main.go": "package main\n",
      "docs/contracts/README.md": "# Contracts\n",
      "mac/README.md": "# Pando.app\n",
      "worker/src/index.ts": INDEX_TS,
    },
    "Merge web-api at 540e076: merges use the recorded heads",
  );
  pushBranch(machine, "artifact-fs", fs, "main", { "README.md": "# artifact-fs\n" }, "Merge index-stat: a fresh mount's first git status downloads nothing");
  const live = pushBranch(anaMbp, "pando", pando, "live", { "README.md": "# Pando\n\nLarge files through R2.\n" }, "live: large files go to R2 by their sha256\n\nCo-authored-by: Codex <codex@openai.invalid>");
  const docs = pushBranch(machine, "pando", pando, "docs", { "README.md": "# Pando\n\nA git platform for monorepos.\n" }, "docs: the README names the parts");
  // projects/pando requires ci (.pando/pando.toml): it passes, then docs merges, and live (which changed the README too) conflicts.
  await ciStatus(machine, "ramos/pando", "projects-pando", docs, "ci", "success");
  await machine.api("POST", "/v1/monorepos/ramos/pando/repos/projects-pando/branches/docs/merge");
  const webApiMerge = pushBranch(sandbox, "pando", pando, "web-api", { "worker/src/main.ts": "export {};\n" }, "Merge branch 'main' into web-api");

  const webApi = pushBranch(
    sandbox,
    "pando",
    pando,
    "web-api",
    { "worker/src/gitwrite.ts": GITWRITE_TS, "worker/src/index.ts": INDEX_TS_WEB_API },
    "gitwrite pushes with the object's cached write token: no mint, info or revoke per push\n\nCo-authored-by: Claude <noreply@anthropic.com>",
  );

  await ciStatus(machine, "ramos/pando", "projects-pando", webApi, "ci", "success");
  await title(machine, "ramos/pando", "projects-pando", "web-api", "Push with the object's cached write token");
  await title(machine, "ramos/pando", "projects-pando", "live", "Large files through R2");
  const cli = pushBranch(machine, "pando", pando, "cli", { "cli/mount.go": "package main\n" }, "cli: pando worktree add mounts through Pando.app when the switch is on");

  await title(machine, "ramos/pando", "projects-pando", "cli", "Mount worktrees through Pando.app when FSKit is on");
  await ciStatus(machine, "ramos/pando", "projects-pando", cli, "ci", "pending");
  const macMount = pushBranch(sandbox2, "artifact-fs", fs, "mac-mount", { "overlay.go": "package overlay\n" }, "overlay: backing files keep owner read and write whatever mode is set");
  const chips = pushBranch(machine, "workspaces", ws, "decision-chips", { "chips.ts": "export {};\n" }, "Show the linked decision on each card");
  const heads = (await (await machine.api("GET", "/v1/monorepos/ramos/pando/heads")).json()).heads;
  const pandoMain = heads.find((h: { path: string }) => h.path === "projects/pando").head;

  // Each machine's socket, with its worktrees: connected while the shots run.
  const sockets = [
    await anaMbp.follow("ramos/pando", ["wt-live"]),
    await machine.follow("ramos/pando", ["wt-cli", "wt-mac-mount"]),
    await sandbox.follow("ramos/pando", ["wt-web-api"]),
    await sandbox2.follow("ramos/pando", ["wt-fs-mac-mount"]),
    await sandbox.follow("ramos/workspaces", ["wt-search-index"]),
    await machine.follow("ramos/workspaces", ["wt-decision-chips"]),
  ];

  const ci = await seedCi(machine, { pandoMain, live, webApiMerge, webApi, cli, macMount, wsMain, failing, chips });

  return { machine, sandbox, sockets, buildkites: ci.buildkites, runningJob: ci.runningJob };
}

/** The commits the prototype's builds are of. */
interface Shas {
  pandoMain: string;
  live: string;
  webApiMerge: string;
  webApi: string;
  cli: string;
  macMount: string;
  wsMain: string;
  failing: string;
  chips: string;
}

interface JobSeed {
  key: string;
  state: "passed" | "failed" | "running";
  /** Seconds it took, or has run. */
  took: number;
  log?: string;
}

interface BuildSeed {
  slug: string;
  n: number;
  sha: string;
  branch: string;
  message: string;
  state: "passed" | "failed" | "running";
  /** Seconds ago it was made, and how long it ran. */
  ago: number;
  took: number;
  jobs: JobSeed[];
}

/** One build as Buildkite's webhooks report it: scheduled, each job, then finished (unless it still runs). */
async function report(bk: Buildkite, b: BuildSeed): Promise<string> {
  const now = Date.now();
  const at = (s: number) => new Date(now - s * 1000).toISOString();
  const made = { commit: b.sha, branch: b.branch, message: b.message, created_at: at(b.ago) };
  const run = { ...made, state: "running", started_at: at(b.ago - 1) };
  let running = "";

  await bk.send("build.scheduled", b.slug, b.n, made);

  for (const [i, j] of b.jobs.entries()) {
    const id = `job-${b.n}-${j.key}`;
    const start = b.ago - 1 - i;
    const job = { id, key: j.key, created_at: at(b.ago - i * 0.1), started_at: at(start) };

    if (j.log) bk.logs.set(id, j.log);

    if (j.state === "running") {
      running = id;
      await bk.send("job.started", b.slug, b.n, run, { ...job, state: "running", started_at: at(j.took) });
    } else {
      await bk.send("job.finished", b.slug, b.n, run, { ...job, state: j.state, exit_status: j.state === "passed" ? 0 : 1, finished_at: at(start - j.took) });
    }
  }

  if (b.state !== "running") await bk.send("build.finished", b.slug, b.n, { ...made, state: b.state, started_at: at(b.ago - 1), finished_at: at(b.ago - 1 - b.took) });

  return running;
}

const FAILING_LOG = "$ npm test\n\u001b[31mFAIL\u001b[0m  test/gitwrite.test.ts > push reuses the cached write token\n  expected 1 token mint, saw 2\n    at test/gitwrite.test.ts:88:5\n\nTests  \u001b[1m1 failed\u001b[22m, 41 passed (42)\n";

const PANDO_CI = "steps:\n  - label: typecheck\n    key: typecheck\n    command: npm run typecheck\n\n  - label: ci\n    key: ci\n    command:\n      - npm test\n      - node test/edge.mjs\n    concurrency: 1\n    concurrency_group: pando-dev\n    artifact_paths:\n      - test-results/*.xml\n      - coverage/lcov.info\n";

/** Buildkite connected to both monorepos (stand-ins), their pipelines, and the prototype's builds. */
async function seedCi(machine: Machine, s: Shas): Promise<{ buildkites: Buildkite[]; runningJob: string }> {
  const bk = await Buildkite.start("pando");
  const ws = await Buildkite.start("plannotator");

  await bk.connect(machine, "ramos/pando");
  await bk.pipeline(machine, "ramos/pando", "projects-pando", "pando-ci");
  await bk.pipeline(machine, "ramos/pando", "projects-artifact-fs", "artifact-fs-e2e");
  bk.yaml.set("pando-ci", PANDO_CI);
  await ws.connect(machine, "ramos/workspaces");
  await ws.pipeline(machine, "ramos/workspaces", "projects-workspaces", "web-ci");

  const tc = (took: number): JobSeed => ({ key: "typecheck", state: "passed", took });

  await report(bk, { slug: "pando-ci", n: 1283, sha: s.live, branch: "live", message: "live: meta/blobs serves a large file to members only", state: "passed", ago: 1080, took: 168, jobs: [tc(21), { key: "ci", state: "passed", took: 143 }] });
  await report(bk, { slug: "pando-ci", n: 1284, sha: s.pandoMain, branch: "main", message: "Merge web-api at 540e076: merges use the recorded heads when expected_head matches", state: "passed", ago: 720, took: 211, jobs: [tc(25), { key: "ci", state: "passed", took: 182 }] });
  await report(bk, { slug: "pando-ci", n: 1285, sha: s.webApiMerge, branch: "web-api", message: "Merge branch 'main' into web-api", state: "failed", ago: 360, took: 115, jobs: [tc(23), { key: "ci", state: "failed", took: 92, log: FAILING_LOG }] });
  bk.annotations.set(1285, [{ id: "an-1285", context: "test-summary", style: "error", body_html: "<p><strong>1 failed</strong>, 41 passed</p><p><code>test/gitwrite.test.ts</code> push reuses the cached write token</p>" }]);
  bk.artifacts.set(1285, [{ id: "art-1285", job_id: "job-1285-ci", path: "test-results/junit.xml", filename: "junit.xml", file_size: 38 * 1024 }]);
  await report(bk, { slug: "artifact-fs-e2e", n: 412, sha: s.macMount, branch: "mac-mount", message: "overlay: backing files keep owner read and write whatever mode is set", state: "running", ago: 60, took: 0, jobs: [{ key: "build", state: "passed", took: 18 }, { key: "e2e-linux", state: "running", took: 34 }] });
  await report(bk, { slug: "pando-ci", n: 1287, sha: s.webApi, branch: "web-api", message: "gitwrite pushes with the object's cached write token: no mint, info or revoke per push", state: "passed", ago: 240, took: 192, jobs: [tc(24), { key: "ci", state: "passed", took: 168 }] });
  bk.annotations.set(1287, [{ id: "an-1287", context: "coverage", style: "info", body_html: "<p>Coverage <strong>81.4%</strong> of lines in <code>worker/src</code></p>" }]);

  const runningJob = await report(bk, {
    slug: "pando-ci",
    n: 1288,
    sha: s.cli,
    branch: "cli",
    message: "cli: pando worktree add mounts through Pando.app when the switch is on",
    state: "running",
    ago: 12,
    took: 0,
    jobs: [tc(22), { key: "ci", state: "running", took: 42, log: "$ npm test\n\u001b[32m✓\u001b[0m 41 passed\n$ node test/edge.mjs\nconnecting to pando-dev\n" }],
  });

  await report(ws, { slug: "web-ci", n: 2201, sha: s.wsMain, branch: "main", message: "Merge callout-seam: callouts keep their seam on narrow cards", state: "passed", ago: 3600, took: 302, jobs: [{ key: "lint", state: "passed", took: 12 }, { key: "ci", state: "passed", took: 161 }, { key: "e2e", state: "passed", took: 298 }] });
  await report(ws, { slug: "web-ci", n: 2202, sha: s.chips, branch: "decision-chips", message: "Show the linked decision on each card", state: "running", ago: 60, took: 0, jobs: [{ key: "lint", state: "passed", took: 11 }, { key: "ci", state: "running", took: 119 }, { key: "e2e", state: "running", took: 100 }] });
  await report(ws, {
    slug: "web-ci",
    n: 2203,
    sha: s.failing,
    branch: "search-index",
    message: "search: a ranking test for exact names",
    state: "failed",
    ago: 300,
    took: 245,
    jobs: [{ key: "lint", state: "passed", took: 12 }, { key: "ci", state: "passed", took: 157 }, { key: "e2e", state: "failed", took: 245, log: 'FAIL  search ranks exact names first (1.8 s)\n  expected "getting-started.md" at 1, got "decision-records.md"\n\n1 failed, 23 passed\n' }],
  });
  ws.annotations.set(2203, [{ id: "an-2203", context: "e2e-summary", style: "error", body_html: "<p><strong>1 failed</strong>, 23 passed</p><p>search ranks exact names first</p>" }]);
  ws.artifacts.set(2203, [{ id: "art-2203", job_id: "job-2203-e2e", path: "e2e/screenshots/search-ranking.png", filename: "search-ranking.png", file_size: 184 * 1024 }]);

  return { buildkites: [bk, ws], runningJob };
}

/** PANDO_SHOTS=mono-,ci- shoots only the pairs whose names start so (a quicker look at one slice); unset, all of them. */
const wanted = (name: string) => !process.env.PANDO_SHOTS || process.env.PANDO_SHOTS.split(",").some((p) => name.startsWith(p));

const settle = async (page: Page) => {
  // Rows fill in after the page shows (last commits, counts): wait until the network is quiet.
  await page.waitForLoadState("networkidle");
  // Load both faces before the shot: fonts.ready alone can resolve before a face is first used.
  await page.evaluate(() => Promise.all([document.fonts.load('14px "SF Mono"'), document.fonts.load('14px "SF Pro Text"'), document.fonts.load('600 14px "SF Pro Text"')]));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
};

/** The app's screen and the prototype's, same size, same settings. */
/** `proto` is the prototype's route when its data differs (its workspaces belongs to plannotator). */
interface Box {
  x: number;
  y: number;
  h: number;
}

/** A landmark's box: the first element that shows exactly that text. */
async function box(p: Page, text: string): Promise<Box | null> {
  const b = await p.getByText(text, { exact: true }).first().boundingBox({ timeout: 2000 }).catch(() => null);

  return b && { x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, h: Math.round(b.height * 10) / 10 };
}

/** Each landmark's position and height in the app and in the prototype, and how far apart they are, into <name>-<width>-marks.json. */
async function measure(page: Page, proto: Page, file: string, marks: readonly string[]) {
  const rows = [];

  for (const mark of marks) {
    const [real, design] = [await box(page, mark), await box(proto, mark)];

    rows.push({ mark, real, proto: design, dx: real && design ? real.x - design.x : null, dy: real && design ? real.y - design.y : null, dh: real && design ? real.h - design.h : null });
  }

  writeFileSync(file, `${JSON.stringify(rows, null, 1)}\n`);
}

/**
 * The page's rows and columns, into <name>-<width>-rows.json, so two builds can
 * be compared (a font change must not move them): every list row (the app's
 * rows are CSS grids, code lines aside) with its top, height and each cell's
 * left and right edges, and the headings.
 */
async function rows(page: Page, file: string) {
  const found = await page.evaluate(() => {
    const r = (n: number) => Math.round(n * 10) / 10;

    return [...document.querySelectorAll<HTMLElement>("body *")].flatMap((el) => {
      const b = el.getBoundingClientRect();
      const row = (getComputedStyle(el).display === "grid" && !el.closest("pre")) || /^H[1-3]$/.test(el.tagName);

      if (!row || b.height === 0 || b.height >= 200) return [];

      return [
        {
          tag: el.tagName.toLowerCase(),
          text: (el.textContent ?? "").trim().slice(0, 40),
          y: r(b.top + scrollY),
          h: r(b.height),
          cols: [...el.children].map((c) => {
            const cell = c.getBoundingClientRect();

            return [r(cell.left), r(cell.right)];
          }),
        },
      ];
    });
  });

  writeFileSync(file, `${JSON.stringify(found, null, 1)}\n`);
}

/** A dropdown trigger in both: the app's (by role) and the prototype's (a selector). */
interface Trigger {
  name: string;
  real: (p: Page) => Locator;
  proto: string;
}

interface CaretBox {
  /** The arrow's width and height, its right edge's inset from the trigger's outer edge, its centre's offset from the trigger's (+ is lower). */
  w: number;
  h: number;
  right: number;
  centre: number;
}

/** A trigger's arrow, measured: inside a button (the prototype's .chev, the app's [data-caret]), or beside a select in its wrapper; null for a native arrow (no element). */
const caretOf = (el: Element): CaretBox | null => {
  const caret = el.querySelector("[data-caret], .chev") ?? (el.tagName === "SELECT" ? el.parentElement?.querySelector("[data-caret]") : null);

  if (!caret) return null;
  const b = el.getBoundingClientRect();
  const c = caret.getBoundingClientRect();
  const r = (n: number) => Math.round(n * 100) / 100;

  return { w: r(c.width), h: r(c.height), right: r(b.right - c.right), centre: r(c.top + c.height / 2 - (b.top + b.height / 2)) };
};

/** Each trigger's arrow in the app and in the prototype, into <name>-<width>-carets.json. */
async function measureCarets(page: Page, proto: Page, file: string, triggers: readonly Trigger[]) {
  const rows = [];

  for (const t of triggers) {
    const real = await t.real(page).first().evaluate(caretOf).catch(() => null);
    const design = await proto.locator(t.proto).first().evaluate(caretOf).catch(() => null);
    const native = design ? null : await proto.locator(t.proto).first().evaluate((el) => (el.tagName === "SELECT" ? getComputedStyle(el).paddingRight : null)).catch(() => null);

    rows.push({ trigger: t.name, real, proto: design ?? (native ? { native_arrow: true, padding_right: native } : null) });
  }

  writeFileSync(file, `${JSON.stringify(rows, null, 1)}\n`);
}

async function pair(
  page: Page,
  proto: Page,
  name: string,
  route: string,
  opts: { query?: string; click?: string; protoClick?: string; proto?: string; marks?: readonly string[]; carets?: readonly Trigger[] } = {},
) {
  if (!wanted(name)) return;

  await page.goto(`${route}${opts.query ? `?${opts.query}` : ""}`);
  await settle(page);

  if (opts.click) {
    await page.getByRole("button", { name: opts.click, exact: true }).first().click();
    await page.waitForTimeout(400);
  }

  const width = page.viewportSize()?.width ?? 1440;
  await page.screenshot({ path: `${SHOTS}${name}-${width}-real.png` });
  await rows(page, `${SHOTS}${name}-${width}-rows.json`);
  await proto.goto(`${PROTOTYPE}${opts.query ? `?${opts.query}` : ""}#${opts.proto ?? route}`);
  await settle(proto);

  if (opts.protoClick) {
    await proto.click(opts.protoClick);
    await proto.waitForTimeout(400);
  }

  await proto.screenshot({ path: `${SHOTS}${name}-${width}-proto.png` });

  if (opts.marks) await measure(page, proto, `${SHOTS}${name}-${width}-marks.json`, opts.marks);

  if (opts.carets) await measureCarets(page, proto, `${SHOTS}${name}-${width}-carets.json`, opts.carets);
}

/** Each theme of the name menu's setting, dark and light: the home and a code file (the app alone: the prototype has no Cloudflare or Pando light), and the menu open. */
async function themes(page: Page) {
  if (!wanted("theme-")) return;

  for (const theme of ["pando", "plannotator", "iris", "cloudflare"]) {
    for (const mode of ["dark", "light"]) {
      for (const [name, route] of [
        ["home", "/"],
        ["code-file", "/ramos/pando/projects/pando/blob/worker/src/index.ts"],
      ] as const) {
        await page.goto(`${route}?theme=${theme}-${mode}`);
        await settle(page);
        await page.screenshot({ path: `${SHOTS}theme-${theme}-${mode}-${name}-1440-real.png` });
      }
    }
  }

  for (const pair of ["pando-dark", "cloudflare-light"]) {
    await page.goto(`/?theme=${pair}`);
    await settle(page);
    await page.getByRole("button", { name: "ramos", exact: true }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}theme-menu-${pair}-1440-real.png`, clip: { x: 1440 - 360, y: 0, width: 360, height: 480 } });
    await page.keyboard.press("Escape");
  }

  await page.goto("/?theme=pando");
}

/** Black Rainbow (dark only, plain black): its screens and the menu at 1440, the home at 390. */
async function blackRainbow(page: Page) {
  if (!wanted("br-")) return;

  const screens = [
    ["home", "/"],
    ["code-file", "/ramos/pando/projects/pando/blob/worker/src/index.ts"],
    ["branch", "/ramos/pando/projects/pando/branches/web-api"],
    ["files-changed", "/ramos/pando/projects/pando/branches/web-api?tab=files"],
  ] as const;

  for (const [name, route] of screens) {
    await page.goto(`${route}${route.includes("?") ? "&" : "?"}theme=black-rainbow`);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}br-${name}-1440-real.png` });
  }

  await page.goto("/?theme=black-rainbow");
  await settle(page);
  await page.getByRole("button", { name: "ramos", exact: true }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}br-menu-1440-real.png`, clip: { x: 1440 - 360, y: 0, width: 360, height: 560 } });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?theme=black-rainbow");
  await settle(page);
  await page.screenshot({ path: `${SHOTS}br-home-390-real.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?theme=pando");
}

/** Avatars in each theme, dark and light where it has light: the home (monorepos, Needs you, activity) and the members page. */
async function avatars(page: Page) {
  if (!wanted("avatars-")) return;

  const pairs = ["pando-dark", "pando-light", "plannotator-dark", "plannotator-light", "iris-dark", "iris-light", "cloudflare-dark", "cloudflare-light", "black-rainbow"];

  for (const pair of pairs) {
    for (const [name, route] of [
      ["home", "/"],
      ["members", "/ramos/pando/members"],
    ] as const) {
      await page.goto(`${route}?theme=${pair}`);
      await settle(page);
      await page.screenshot({ path: `${SHOTS}avatars-${pair}-${name}-1440-real.png` });
    }
  }

  await page.goto("/?theme=pando");
}

/** The home's What's new block, close, at both widths. */
async function whatsNew(page: Page) {
  if (!wanted("whatsnew-")) return;

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await page.goto("/");
    await settle(page);
    const block = page.getByRole("link", { name: "Changelog" }).locator("xpath=..");
    await block.scrollIntoViewIfNeeded();
    const b = await block.boundingBox();

    if (b) await page.screenshot({ path: `${SHOTS}whatsnew-${width}-real.png`, clip: { x: Math.max(0, b.x - 24), y: Math.max(0, b.y - 24), width: Math.min(width, b.width + 48), height: b.height + 48 } });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
}

const FILTER: Trigger = { name: "home filter", real: (p) => p.getByRole("button", { name: "All repositories" }), proto: "#pickb" };

const SWITCHER: Trigger = { name: "monorepo switcher", real: (p) => p.getByRole("button", { name: "Switch repository" }), proto: "#sw" };

const PROJECT_SWITCHER: Trigger = { name: "project switcher", real: (p) => p.getByRole("button", { name: "Switch project" }), proto: "#psw" };

const CLONE: Trigger = { name: "Clone", real: (p) => p.getByRole("button", { name: "Clone" }), proto: "#clb" };

const CLONE_SELECT: Trigger = { name: "Clone's project select", real: (p) => p.getByRole("combobox", { name: "Project" }), proto: "#clsel" };

const PICKER: Trigger = { name: "branch picker", real: (p) => p.getByRole("button", { name: /^main|^web-api/ }), proto: "#bpb" };

const ROLE: Trigger = { name: "Invite's role select", real: (p) => p.getByRole("combobox", { name: "Role" }), proto: 'select[aria-label="Role"]' };

test.use({ deviceScaleFactor: 2, colorScheme: "dark", reducedMotion: "reduce" });

test("fidelity shots of slices 1 to 3 beside the prototype", async ({ page, browser }) => {
  test.setTimeout(600_000);
  await nextSignIn(ramos);
  await page.goto("/login");

  // The sign-in page has no prototype screen: shot alone, at both widths.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await settle(page);
    await page.screenshot({ path: `${SHOTS}sign-in-${width}-real.png` });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
  const shown = await seed(page, browser);
  // Let branch facts and the feed's summary line settle (the line ticks every 10 s).
  await expect(async () => {
    const needs = await (await page.request.get("/v1/branches")).json();
    expect(needs.branches.length).toBeGreaterThanOrEqual(3);
  }).toPass({ timeout: 60_000 });
  await page.waitForTimeout(11_000);

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const proto = await browser.newPage({ viewport: { width, height: width === 1440 ? 900 : 844 }, deviceScaleFactor: 2, colorScheme: "dark", reducedMotion: "reduce" });
    await pair(page, proto, "home", "/", { carets: [FILTER] });
    await pair(page, proto, "code-root", "/ramos/pando", { carets: [SWITCHER, CLONE] });
    await pair(page, proto, "file", "/ramos/pando/blob/decisions/RULINGS.md");

    if (width === 1440) {
      await pair(page, proto, "home-filter", "/", { click: "All repositories", protoClick: "#pickb", carets: [FILTER] });
      await pair(page, proto, "clone-panel", "/ramos/pando", { click: "Clone", protoClick: "#clb", carets: [CLONE, CLONE_SELECT] });
      await pair(page, proto, "code-decisions", "/ramos/pando/tree/decisions");
      await pair(page, proto, "file-history", "/ramos/pando/history/decisions/RULINGS.md");
      await pair(page, proto, "home-light", "/", { query: "theme=iris-light" });
      await pair(page, proto, "file-light", "/ramos/pando/blob/decisions/RULINGS.md", { query: "theme=iris-light" });
      await page.goto("/?theme=pando");
      await proto.goto(`${PROTOTYPE}?theme=pando#/`);
      // Slice 2
      await pair(page, proto, "branches", "/ramos/pando/projects/pando/branches");
      await pair(page, proto, "branches-merged", "/ramos/pando/projects/pando/branches?tab=merged");
      await pair(page, proto, "branch", "/ramos/pando/projects/pando/branches/web-api");
      await pair(page, proto, "branch-checks", "/ramos/workspaces/projects/workspaces/branches/search-index", { proto: "/plannotator/workspaces/projects/workspaces/branches/search-index" });
      await pair(page, proto, "branch-waiting", "/ramos/pando/projects/pando/branches/cli");
      await pair(page, proto, "branch-conflicts", "/ramos/pando/projects/pando/branches/live");
      await pair(page, proto, "branch-picker", "/ramos/pando/projects/pando", { click: "main", protoClick: "#bpb", carets: [PICKER, SWITCHER, PROJECT_SWITCHER] });
      await pair(page, proto, "code-branch-ref", "/ramos/pando/projects/pando?ref=web-api", { carets: [PICKER] });
      await pair(page, proto, "code-file", "/ramos/pando/projects/pando/blob/worker/src/index.ts");
      await pair(page, proto, "code-history", "/ramos/pando/projects/pando/history/worker/src/index.ts");
      await pair(page, proto, "activity", "/ramos/pando/activity");
      // Slice 3
      await pair(page, proto, "mono-machines", "/ramos/pando/machines", { marks: ["Machine", "Worktrees", "Now", "ramos-mbp", "sandbox-1", "connected"] });
      await pair(page, proto, "machines", "/settings/machines", { marks: ["Your machines", "Name", "Kind", "Last used", "ramos-mbp", "this browser", "this session", "Add a cloud sandbox", "Copy"] });
      await pair(page, proto, "members", "/ramos/pando/members", {
        marks: ["Person", "Role", "Active", "Michael Ramos", "Ana Lopes", "you", "Remove", "Invite", "Invited", "ben@example.com", "Revoke"],
        carets: [ROLE],
      });
      await pair(page, proto, "settings", "/ramos/pando/settings", { marks: ["Name", "Rename", "Delete this repository", "Delete ramos/pando"] });
      await pair(page, proto, "mono-ci", "/ramos/pando/ci", {
        marks: ["CI service", "Buildkite", "pando", "Webhook", "Copy", "Disconnect", "Pipelines", "Project", "Required to merge", "Last build", "projects/pando", "Recent builds", "Merge branch 'main' into web-api", "#1285"],
      });
      await pair(page, proto, "mono-ci-workspaces", "/ramos/workspaces/ci", { proto: "/plannotator/workspaces/ci", marks: ["projects/workspaces-cli", "Add pipeline", "Connect another CI service"] });
      await pair(page, proto, "ci-pipeline", "/ramos/pando/ci/pando-ci", { marks: ["Open in Buildkite", "New build", "pipeline.yml", "Copy", "Builds"] });
      await pair(page, proto, "ci-build", "/ramos/pando/ci/pando-ci/1285", {
        marks: ["Merge branch 'main' into web-api", "#1285", "Open in Buildkite", "Rebuild", "test-summary", "typecheck", "exit status 1", "Retry", "Artifacts", "test-results/junit.xml", "Download"],
      });
      await pair(page, proto, "ci-build-running", "/ramos/pando/ci/pando-ci/1288", { marks: ["#1288", "Cancel", "typecheck", "running"] });
      // The running job open on its log (the prototype's job opened by a click).
      await pair(page, proto, "ci-build-running-log", `/ramos/pando/ci/pando-ci/1288?job=${shown.runningJob}`, { proto: "/ramos/pando/ci/pando-ci/1288", protoClick: '.job[data-j="1"]' });
      await pair(page, proto, "ci-build-workspaces", "/ramos/workspaces/ci/web-ci/2203", { proto: "/plannotator/workspaces/ci/web-ci/2203" });
      await pair(page, proto, "mono-machines-light", "/ramos/pando/machines", { query: "theme=iris-light" });
      await pair(page, proto, "machines-light", "/settings/machines", { query: "theme=iris-light" });
      await pair(page, proto, "mono-ci-light", "/ramos/pando/ci", { query: "theme=iris-light" });
      await pair(page, proto, "ci-build-light", "/ramos/pando/ci/pando-ci/1285", { query: "theme=iris-light" });
      await page.goto("/?theme=pando");
      await proto.goto(`${PROTOTYPE}?theme=pando#/`);
    } else {
      await pair(page, proto, "branch", "/ramos/pando/projects/pando/branches/web-api");
      await pair(page, proto, "branches", "/ramos/pando/projects/pando/branches");
      await pair(page, proto, "activity", "/ramos/pando/activity");
      await pair(page, proto, "file-history", "/ramos/pando/history/decisions/RULINGS.md");
      await pair(page, proto, "file-history-long", "/ramos/pando/history/research/plans/architecture-2026-10-03/NAMESPACES.md");
      await pair(page, proto, "mono-machines", "/ramos/pando/machines");
      await pair(page, proto, "mono-ci", "/ramos/pando/ci");
      await pair(page, proto, "ci-build", "/ramos/pando/ci/pando-ci/1285");
      await pair(page, proto, "ci-pipeline", "/ramos/pando/ci/pando-ci");
      // The dropdowns at phone width.
      await pair(page, proto, "home-filter", "/", { click: "All repositories", protoClick: "#pickb", carets: [FILTER] });
      await pair(page, proto, "clone-panel", "/ramos/pando", { click: "Clone", protoClick: "#clb", carets: [CLONE, CLONE_SELECT] });
      await pair(page, proto, "branch-picker", "/ramos/pando/projects/pando", { click: "main", protoClick: "#bpb", carets: [PICKER] });
      await pair(page, proto, "members", "/ramos/pando/members", { carets: [ROLE] });
    }

    await proto.close();
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await themes(page);
  await blackRainbow(page);
  await avatars(page);
  await whatsNew(page);

  for (const ws of shown.sockets) ws.close();

  for (const bk of shown.buildkites) await bk.close();
});
