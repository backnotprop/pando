// Fidelity shots, not assertions: the design (v3/prototype.html) is the bar.
// It makes a monorepo shaped like the prototype's (ramos/pando, its root files,
// two projects, branches that are ready, conflicting and failing), then shoots
// each slice 1 screen next to the prototype's own route, at the prototype's
// settings (2x, dark, reduced motion, 1.5 s after load), into e2e/shots/.
//
//   npm run shots      (the Worker with this worktree's own state; the persona `ramos` is local to it)
import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BASE, browserPost, ciStatus, Machine, nextSignIn, saveRootFiles } from "./seed";

const PROTOTYPE = pathToFileURL(fileURLToPath(new URL("../../../../../../research/design/pando-ui-2026-10-03/v3/prototype.html", import.meta.url))).href;

const SHOTS = fileURLToPath(new URL("shots/", import.meta.url));

const ramos = { id: "user_ramos_local", email: "ramos@pando.invalid", email_verified: true, first_name: "Michael", last_name: "Ramos" };

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

async function seed(page: Page): Promise<Showcase> {
  const machine = await Machine.make(page, "ramos-mbp", "ramos");
  const sandbox = await Machine.make(page, "sandbox-1", "ramos");
  await remake(page, machine, "pando-brand", "repo");
  await remake(page, machine, "workspaces", "monorepo");
  await remake(page, machine, "pando", "monorepo");

  const brand = (await (await machine.api("GET", "/v1/monorepos/ramos/pando-brand/repos")).json()).repos[0].clone_url;
  pushBranch(machine, "brand", brand, "main", { "README.md": "# pando-brand\n" }, "The 01E2 Daylight card");

  const ws = await project(page, "workspaces", "projects/workspaces");
  await saveRootFiles(page, "ramos/workspaces", "ramos-mbp", { "AGENTS.md": "# Workspaces\n\nThe monorepo for Workspaces.\n" });
  pushBranch(machine, "workspaces", ws, "main", { "README.md": "# workspaces\n" }, "Merge callout-seam: callouts keep their seam on narrow cards");
  pushBranch(sandbox, "workspaces", ws, "search-index", { "search.ts": "export {};\n" }, "search: index customer-docs on every save\n\nCo-authored-by: Claude <noreply@anthropic.com>");
  const failing = pushBranch(sandbox, "workspaces", ws, "search-index", { "rank.test.ts": "export {};\n" }, "search: a ranking test for exact names");

  await title(machine, "ramos/workspaces", "projects-workspaces", "search-index", "Index customer docs for search");
  await ciStatus(machine, "ramos/workspaces", "projects-workspaces", failing, "ci", "success");
  await ciStatus(machine, "ramos/workspaces", "projects-workspaces", failing, "e2e", "failure");

  const pando = await project(page, "pando", "projects/pando");
  const fs = await project(page, "pando", "projects/artifact-fs");
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
      "worker/src/index.ts": "// The Pando Worker: the one way in.\nexport default {};\n",
    },
    "Merge web-api at 540e076: merges use the recorded heads",
  );
  pushBranch(machine, "artifact-fs", fs, "main", { "README.md": "# artifact-fs\n" }, "Merge index-stat: a fresh mount's first git status downloads nothing");
  pushBranch(machine, "pando", pando, "live", { "README.md": "# Pando\n\nLarge files through R2.\n" }, "live: large files go to R2 by their sha256\n\nCo-authored-by: Codex <codex@openai.invalid>");
  pushBranch(machine, "pando", pando, "docs", { "README.md": "# Pando\n\nA git platform for monorepos.\n" }, "docs: the README names the parts");
  await machine.api("POST", "/v1/monorepos/ramos/pando/repos/projects-pando/branches/docs/merge");
  pushBranch(sandbox, "pando", pando, "web-api", { "worker/src/main.ts": "export {};\n" }, "Merge branch 'main' into web-api");

  const webApi = pushBranch(
    sandbox,
    "pando",
    pando,
    "web-api",
    { "worker/src/gitwrite.ts": "export {};\n" },
    "gitwrite pushes with the object's cached write token: no mint, info or revoke per push\n\nCo-authored-by: Claude <noreply@anthropic.com>",
  );

  await ciStatus(machine, "ramos/pando", "projects-pando", webApi, "ci", "success");
  await title(machine, "ramos/pando", "projects-pando", "web-api", "Push with the object's cached write token");
  await title(machine, "ramos/pando", "projects-pando", "live", "Large files through R2");
  await sandbox.api("PUT", "/v1/monorepos/ramos/pando/worktrees/wt-web-api", {
    repo: "projects/pando",
    branch: "web-api",
    path: "projects/pando/worktrees/web-api",
    machine: "sandbox-1",
    kind: "fuse",
  });
  const cli = pushBranch(machine, "pando", pando, "cli", { "cli/mount.go": "package main\n" }, "cli: pando worktree add mounts through Pando.app when the switch is on");

  await title(machine, "ramos/pando", "projects-pando", "cli", "Mount worktrees through Pando.app when FSKit is on");
  await ciStatus(machine, "ramos/pando", "projects-pando", cli, "ci", "pending");
  pushBranch(sandbox, "artifact-fs", fs, "mac-mount", { "overlay.go": "package overlay\n" }, "overlay: backing files keep owner read and write");

  return { machine, sandbox };
}

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
async function pair(page: Page, proto: Page, name: string, route: string, opts: { query?: string; click?: string; protoClick?: string; proto?: string } = {}) {
  await page.goto(`${route}${opts.query ? `?${opts.query}` : ""}`);
  await settle(page);

  if (opts.click) {
    await page.getByRole("button", { name: opts.click, exact: true }).first().click();
    await page.waitForTimeout(400);
  }

  const width = page.viewportSize()?.width ?? 1440;
  await page.screenshot({ path: `${SHOTS}${name}-${width}-real.png` });
  await proto.goto(`${PROTOTYPE}${opts.query ? `?${opts.query}` : ""}#${opts.proto ?? route}`);
  await settle(proto);

  if (opts.protoClick) {
    await proto.click(opts.protoClick);
    await proto.waitForTimeout(400);
  }

  await proto.screenshot({ path: `${SHOTS}${name}-${width}-proto.png` });
}

test.use({ deviceScaleFactor: 2, colorScheme: "dark", reducedMotion: "reduce" });

test("fidelity shots of slice 1 beside the prototype", async ({ page, browser }) => {
  test.setTimeout(300_000);
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
  await seed(page);
  // Let branch facts and the feed's summary line settle (the line ticks every 10 s).
  await expect(async () => {
    const needs = await (await page.request.get("/v1/branches")).json();
    expect(needs.branches.length).toBeGreaterThanOrEqual(3);
  }).toPass({ timeout: 60_000 });
  await page.waitForTimeout(11_000);

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    const proto = await browser.newPage({ viewport: { width, height: width === 1440 ? 900 : 844 }, deviceScaleFactor: 2, colorScheme: "dark", reducedMotion: "reduce" });
    await pair(page, proto, "home", "/");
    await pair(page, proto, "code-root", "/ramos/pando");
    await pair(page, proto, "file", "/ramos/pando/blob/decisions/RULINGS.md");

    if (width === 1440) {
      await pair(page, proto, "home-filter", "/", { click: "All monorepos", protoClick: "#pickb" });
      await pair(page, proto, "clone-panel", "/ramos/pando", { click: "Clone", protoClick: "#clb" });
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
      await pair(page, proto, "branch-picker", "/ramos/pando/projects/pando", { click: "main", protoClick: "#bpb" });
      await pair(page, proto, "code-branch-ref", "/ramos/pando/projects/pando?ref=web-api");
      await pair(page, proto, "code-file", "/ramos/pando/projects/pando/blob/worker/src/index.ts");
      await pair(page, proto, "code-history", "/ramos/pando/projects/pando/history/worker/src/index.ts");
      await pair(page, proto, "activity", "/ramos/pando/activity");
    } else {
      await pair(page, proto, "branch", "/ramos/pando/projects/pando/branches/web-api");
    }

    await proto.close();
  }
});
