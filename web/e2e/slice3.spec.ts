// Slice 3, end to end: a machine connects over its socket and shows on the
// open Machines tab, then its push shows as its last event; Your machines;
// invite and remove a member, and an invite revoked; Buildkite connected
// through a stand-in; a branch's checks moving live as jobs report; a running
// log growing on its build's page; the build failing there, with its
// sanitised annotation, Retry, Rebuild and Cancel; the pipeline's page with
// New build; the CI tab taking a build's change live; a broken pando.toml
// (required checks unknown, and why); then a rename (the old name
// redirects) and a delete with the typed confirmation. No page polls
// while its socket is up. Real Worker, real git, real browser.
import { expect, type Page, test } from "@playwright/test";
import { Buildkite } from "./buildkite";
import { BASE, browserPost, ciStatus, Machine, nextSignIn } from "./seed";

const id = Date.now().toString(36);

const login = `ops-${id}`;

const name = `e2e-${id}`;

const full = `${login}/${name}`;

const renamed = `${name}-new`;

const person = { id: `user_ops_${id}`, email: `${login}@pando.invalid`, email_verified: true, first_name: "Ops", last_name: "Lane" };

// A second person with an account: an invite adds her at once.
const bea = { id: `user_bea_${id}`, email: `bea-${id}@pando.invalid`, email_verified: true, first_name: "Bea", last_name: "Lane" };

/** GETs the page makes for paths matching `path`: `from()` starts counting, `since()` says how many since then. */
function reads(page: Page, path: RegExp) {
  let seen: string[] = [];
  let counting = false;

  page.on("request", (r) => {
    const u = new URL(r.url());

    if (counting && r.method() === "GET" && path.test(u.pathname)) seen.push(u.pathname + u.search);
  });

  return {
    from: () => {
      seen = [];
      counting = true;
    },
    since: () => seen.length,
    seen: () => seen,
  };
}

interface Made {
  machine: Machine | null;
  buildkite: Buildkite | null;
  socket: WebSocket | null;
  name: string;
  /** Other monorepos the run made, deleted at the end. */
  others: string[];
}

test("slice 3: machines, your machines, members, CI with Buildkite, rename and delete", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|404|409)/.test(m.text())) errors.push(m.text());
  });

  const made: Made = { machine: null, buildkite: null, socket: null, name, others: [] };

  const machine = () => {
    if (!made.machine) throw new Error("no machine credential yet");

    return made.machine;
  };

  const buildkite = () => {
    if (!made.buildkite) throw new Error("no Buildkite stand-in yet");

    return made.buildkite;
  };

  try {
    // Bea signs in once, in her own browser, so she has an account.
    const hers = await browser.newContext();

    await nextSignIn(bea);
    await (await hers.newPage()).goto(`${BASE}/login`);
    await hers.pages()[0]?.getByRole("link", { name: "Sign in" }).click();
    await expect(hers.pages()[0] ?? page).toHaveURL(`${BASE}/`);
    await hers.close();

    await nextSignIn(person);
    await page.goto("/login");
    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${BASE}/`);

    let url = "";

    await test.step("a monorepo with a project on main, and a machine", async () => {
      await browserPost(page, "/v1/monorepos", { name });
      url = (await browserPost(page, `/v1/monorepos/${full}/repos`, { path: "projects/web" })).clone_url;
      made.machine = await Machine.make(page, `laptop-${id}`);
      const m = machine();

      m.push(m.commit("web", url, "main", { "README.md": "# web\n" }, "Start the web project"), url, "main");
    });

    // GETs of the Machines tab's list, counted while its socket is up: rows come by the socket, not by polling.
    const machinesReads = reads(page, /\/machines$/);

    await test.step("a machine connects with a worktree: the open Machines tab shows it connected, live", async () => {
      const m = machine();
      const wt = await m.api("PUT", `/v1/monorepos/${full}/worktrees/wt-${id}`, { repo: "projects/web", branch: "feature", path: "projects/web/worktrees/feature", machine: m.name, kind: "sparse" });

      expect(wt.ok).toBe(true);
      await page.goto(`${BASE}/${full}/machines`);
      const row = page.getByRole("list", { name: "Machines" }).getByRole("listitem").filter({ hasText: m.name });

      // Its push of main made its row; it is not connected yet.
      await expect(row.getByText("offline", { exact: true })).toBeVisible();
      await page.waitForTimeout(2000);
      machinesReads.from();
      made.socket = await m.follow(full, [`wt-${id}`]);
      await expect(row.getByText("connected", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(row.getByRole("link", { name: "feature" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: full }).getByRole("link", { name: /Machines/ })).toHaveText(/1$/);
    });

    await test.step("its push becomes its last event; its socket closing leaves it offline", async () => {
      const m = machine();
      const row = page.getByRole("list", { name: "Machines" }).getByRole("listitem").filter({ hasText: m.name });

      m.push(m.commit("web", url, "feature", { "src/a.ts": "export const a = 1;\n" }, "Start a feature"), url, "feature");
      // A new branch's first push opens it.
      await expect(row.getByText("opened", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(row.locator("code", { hasText: "feature" })).toBeVisible();
      made.socket?.close();
      made.socket = null;
      await expect(row.getByText("offline", { exact: true })).toBeVisible({ timeout: 30_000 });
      // Longer than the old 5 s poll: still no read of the list.
      await page.waitForTimeout(6000);
      expect(machinesReads.since()).toBe(0);
    });

    await test.step("Your machines lists the machine and this browser, and revokes a sandbox", async () => {
      await Machine.make(page, `sandbox-${id}`);
      await page.goto(`${BASE}/`);
      await page.getByRole("link", { name: "Your machines" }).click();
      await expect(page).toHaveURL(`${BASE}/settings/machines`);
      const list = page.getByRole("list", { name: "Your machines" });

      await expect(list.getByText(`laptop-${id}`)).toBeVisible();
      await expect(list.getByText("this browser")).toBeVisible();
      await expect(list.getByText("this session")).toBeVisible();
      await list.getByRole("listitem").filter({ hasText: `sandbox-${id}` }).getByRole("button", { name: "Revoke" }).click();
      await expect(list.getByText(`sandbox-${id}`)).toHaveCount(0);
    });

    await test.step("invite a person with an account: she is a member; then remove her", async () => {
      await page.goto(`${BASE}/${full}/members`);
      const members = page.getByRole("list", { name: "Members" });

      await expect(members.getByText("you", { exact: true })).toBeVisible();
      await page.getByRole("textbox", { name: "Email" }).fill(bea.email);
      await page.getByRole("button", { name: "Invite", exact: true }).click();
      await expect(members.getByText(`bea-${id}`, { exact: true })).toBeVisible();
      await expect(page.getByRole("navigation", { name: full }).getByRole("link", { name: /Members/ })).toHaveText(/2$/);
      await members.getByRole("button", { name: `Remove bea-${id}` }).click();
      await expect(members.getByText(`bea-${id}`, { exact: true })).toHaveCount(0);
    });

    await test.step("a large monorepo (the e2e's FEED_FANOUT_MAX is 1: two people make one): a push reaches the open home live, by its own socket", async () => {
      const big = `big-${id}`;
      const branch = `large-${id}`;
      const m = machine();

      await browserPost(page, "/v1/monorepos", { name: big });
      made.others.push(big);
      const appUrl = (await browserPost(page, `/v1/monorepos/${login}/${big}/repos`, { path: "projects/app" })).clone_url;

      m.push(m.commit("app", appUrl, "main", { "README.md": "# app\n" }, "Start the app"), appUrl, "main");
      await browserPost(page, `/v1/monorepos/${login}/${big}/invites`, { email: bea.email, role: "member" });
      // The home's list says so once the person's feed has its line.
      await expect
        .poll(async () => (await (await page.request.get("/v1/monorepos?summary=1")).json()).monorepos.find((x: { name: string }) => x.name === big)?.large, { timeout: 60_000 })
        .toBe(true);
      const sockets: string[] = [];

      page.on("websocket", (ws) => sockets.push(ws.url()));
      await page.goto(`${BASE}/`);
      await expect.poll(() => sockets.some((u) => u.includes(`/v1/monorepos/${login}/${big}/events?topics=feed`))).toBe(true);
      await page.waitForTimeout(2000);
      // Its lines never reach the person's socket; nor does the log poll (one large monorepo, under 5).
      const logReads = reads(page, /^\/v1\/events$/);

      logReads.from();
      m.push(m.commit("app", appUrl, branch, { "a.txt": "a\n" }, "A large monorepo's push"), appUrl, branch);
      await expect(page.getByTestId("activity").getByRole("link", { name: branch }).first()).toBeVisible({ timeout: 30_000 });
      expect(logReads.seen()).toEqual([]);
      // Back to the first monorepo's members, where the next step invites.
      await page.goto(`${BASE}/${full}/members`);
    });

    await test.step("invite an email with no account: it waits under Invited; then revoke it", async () => {
      const email = `nobody-${id}@pando.invalid`;

      await page.getByRole("textbox", { name: "Email" }).fill(email);
      await page.getByRole("combobox", { name: "Role" }).selectOption("owner");
      await page.getByRole("button", { name: "Invite", exact: true }).click();
      const invited = page.getByRole("list", { name: "Invited" });

      await expect(invited.getByText(email)).toBeVisible();
      await expect(invited.getByText("owner")).toBeVisible();
      await invited.getByRole("button", { name: `Revoke the invite for ${email}` }).click();
      await expect(page.getByRole("list", { name: "Invited" })).toHaveCount(0);
    });

    let sha = "";

    await test.step("Buildkite connected: the CI tab shows the service, its webhook and the pipeline", async () => {
      made.buildkite = await Buildkite.start();
      const bk = buildkite();

      await bk.connect(machine(), full);
      await bk.pipeline(machine(), full, "projects-web", "web-ci");
      await page.goto(`${BASE}/${full}/ci`);
      await expect(page.getByText("Buildkite", { exact: true })).toBeVisible();
      await expect(page.getByText(/\/v1\/integrations\/buildkite\//)).toBeVisible();
      const pipelines = page.getByRole("list", { name: "Pipelines" });

      await expect(pipelines.getByRole("link", { name: "web-ci" })).toBeVisible();
      await expect(pipelines.getByText("projects/web")).toBeVisible();
      await expect(page.getByText("No builds yet.")).toBeVisible();
      sha = machine().git(machine().dir("web"), "rev-parse", "HEAD").trim();
    });

    await test.step("Add pipeline: a project with none gets one from a small form (its Buildkite hook)", async () => {
      await browserPost(page, `/v1/monorepos/${full}/repos`, { path: "projects/api" });
      await page.reload();
      const row = page.getByRole("list", { name: "Pipelines" }).getByRole("listitem").filter({ hasText: "projects/api" });

      await row.getByRole("button", { name: "Add pipeline" }).click();
      const form = page.getByRole("form", { name: "Add pipeline" });

      await expect(form.getByRole("combobox", { name: "Project" })).toHaveValue("projects-api");
      await form.getByRole("textbox", { name: "Pipeline" }).fill("api-ci");
      await form.getByRole("button", { name: "Add pipeline" }).click();
      await expect(row.getByRole("link", { name: "api-ci" })).toBeVisible();
      const hooks = await (await machine().api("GET", `/v1/monorepos/${full}/repos/projects-api/hooks`)).json();

      expect(hooks.hooks.some((h: { type: string; buildkite: { pipeline: string } | null }) => h.type === "buildkite" && h.buildkite?.pipeline === "api-ci")).toBe(true);
    });

    const t0 = Date.now();
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    // GETs of stored builds and jobs (the check rows', the CI tab's, a build page's): none while the socket is up.
    const runsReads = reads(page, /\/ci\/builds(\/cib_[^/]+)?$/);
    // And of the branch itself: its checks and gate come as branch.updated rows.
    const branchReads = reads(page, /\/repos\/projects-web\/branches\/feature$/);
    const ciReads = reads(page, /\/ci(\/builds(\/cib_[^/]+)?)?$/);
    const b7 = () => ({ commit: sha, branch: "feature", message: "Start a feature", created_at: at(-60_000) });
    const run7 = () => ({ ...b7(), state: "running", started_at: at(-59_000) });

    await test.step("a branch's checks move live as Buildkite reports its jobs: queued, running with its time, passed with the arrival", async () => {
      const bk = buildkite();

      bk.logs.set("job-ci", "\u001b_bk;t=1759500000000\u0007$ npm test\n");
      await page.goto(`${BASE}/${full}/projects/web/branches/feature`);
      const checks = page.getByRole("list", { name: "Checks" });
      const typecheck = checks.getByRole("listitem").filter({ hasText: "typecheck" });

      // The check rows' builds and jobs come as rows on the page's socket: no read of them once it is up.
      await page.waitForTimeout(2000);
      runsReads.from();
      branchReads.from();
      await bk.send("build.scheduled", "web-ci", 7, b7());
      await bk.send("job.scheduled", "web-ci", 7, run7(), { id: "job-tc", key: "typecheck", state: "scheduled", created_at: at(-59_500) });
      await expect(typecheck.getByText("queued", { exact: true })).toBeVisible({ timeout: 30_000 });
      await bk.send("job.started", "web-ci", 7, run7(), { id: "job-tc", key: "typecheck", state: "running", created_at: at(-59_500), started_at: at(-30_000) });
      await expect(typecheck.getByText("running", { exact: true })).toBeVisible({ timeout: 30_000 });
      // Its elapsed time is shown, and ticks.
      const first = await typecheck.getByText(/\d s$/).textContent();

      await expect(typecheck.getByText(/\d s$/)).not.toHaveText(first ?? "", { timeout: 5_000 });
      await bk.send("job.finished", "web-ci", 7, run7(), { id: "job-tc", key: "typecheck", state: "passed", exit_status: 0, created_at: at(-59_500), started_at: at(-30_000), finished_at: at(-7_000) });
      await expect(typecheck.getByText("passed", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(typecheck).toHaveClass(/arrived/);
      await expect(typecheck.getByText("23 s")).toBeVisible();
      await bk.send("job.scheduled", "web-ci", 7, run7(), { id: "job-ci", key: "ci", state: "scheduled", created_at: at(-59_000) });
      await bk.send("job.started", "web-ci", 7, run7(), { id: "job-ci", key: "ci", state: "running", created_at: at(-59_000), started_at: at(-6_000) });
      await expect(checks.getByRole("listitem").filter({ hasText: "ci" }).filter({ hasNotText: "typecheck" }).getByText("running", { exact: true })).toBeVisible({ timeout: 30_000 });
      expect(runsReads.seen()).toEqual([]);
      expect(branchReads.seen()).toEqual([]);
    });

    await test.step("a check opens its job on the build's page, where the running log grows", async () => {
      await page.getByRole("list", { name: "Checks" }).getByRole("link", { name: "ci", exact: true }).click();
      await expect(page).toHaveURL(`${BASE}/${full}/ci/web-ci/7?job=job-ci`);
      const jobs = page.getByRole("list", { name: "Jobs" });

      await expect(jobs.getByText("$ npm test")).toBeVisible();
      // The log is the service's, kept 10 s by the server for every viewer: it grows within a poll or two.
      buildkite().logs.set("job-ci", "$ npm test\n\u001b[31mFAIL\u001b[0m  test/a.test.ts > a is two\nTests  \u001b[1m1 failed\u001b[22m, 41 passed (42)\n");
      await expect(jobs.getByText("test/a.test.ts > a is two", { exact: false })).toBeVisible({ timeout: 30_000 });
      // Colours rendered simply: red is Rust, bold is bold; Buildkite's marker never shows.
      await expect(jobs.locator("pre span.text-rust", { hasText: "FAIL" })).toBeVisible();
      await expect(jobs.locator("pre span.font-semibold", { hasText: "1 failed" })).toBeVisible();
      await expect(jobs.locator("pre")).not.toContainText("_bk;t=");
    });

    await test.step("the build fails while its page is open: the job's exit status and Retry, the annotation sanitised, the artifact", async () => {
      const bk = buildkite();

      bk.annotations.set(7, [
        {
          id: "an-1",
          context: "test-summary",
          style: "error",
          body_html: `<p><strong>1 failed</strong>, 41 passed</p><img src="x" onerror="window.__pwned = 1"><script>window.__pwned = 2</script><p><a href="javascript:window.__pwned = 3">a link</a></p>`,
        },
      ]);
      bk.artifacts.set(7, [{ id: "art-1", job_id: "job-ci", path: "test-results/junit.xml", filename: "junit.xml", file_size: 38_912 }]);
      ciReads.from();
      await bk.send("job.finished", "web-ci", 7, run7(), { id: "job-ci", key: "ci", state: "failed", exit_status: 1, created_at: at(-59_000), started_at: at(-6_000), finished_at: at(-1_000) });
      await bk.send("build.finished", "web-ci", 7, { ...b7(), state: "failed", started_at: at(-59_000), finished_at: at(-500) });
      const jobs = page.getByRole("list", { name: "Jobs" });

      await expect(jobs.getByText("failed", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(jobs.getByText("exit status 1")).toBeVisible();
      expect(ciReads.seen()).toEqual([]);
      const note = page.getByRole("region", { name: "test-summary" });

      await expect(note.getByText("1 failed")).toBeVisible({ timeout: 30_000 });
      await expect(note.locator("img, script")).toHaveCount(0);
      await expect(note.getByRole("link", { name: "a link" })).toHaveCount(0);
      expect(await page.evaluate(() => "__pwned" in window)).toBe(false);
      const artifact = page.getByRole("list", { name: "Artifacts" }).getByRole("link", { name: "Download" });

      await expect(artifact).toHaveAttribute("href", /\/ci\/builds\/cib_[^/]+\/artifacts\/art-1\/download$/);
      // typecheck, closed, opens to its own log on demand.
      bk.logs.set("job-tc", "tsc --noEmit\n");
      await jobs.getByRole("button", { name: /typecheck/ }).click();
      await expect(jobs.getByText("tsc --noEmit")).toBeVisible();
    });

    await test.step("Retry the failed job: passed to Buildkite, the new job takes its place", async () => {
      await page.getByRole("button", { name: "Retry" }).click();
      await expect.poll(() => buildkite().calls.some((c) => c.endsWith("/builds/7/jobs/job-ci/retry"))).toBe(true);
      await expect(page.getByRole("list", { name: "Jobs" }).getByText("queued")).toBeVisible({ timeout: 15_000 });
    });

    await test.step("Rebuild: a new build of the commit, whose page offers Cancel", async () => {
      await page.getByRole("button", { name: "Rebuild" }).click();
      await expect(page).toHaveURL(`${BASE}/${full}/ci/web-ci/100`, { timeout: 30_000 });
      expect(buildkite().created.some((c) => c.commit === sha && c.branch === "feature")).toBe(true);
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect.poll(() => buildkite().calls.includes("PUT /v2/organizations/o/pipelines/web-ci/builds/100/cancel")).toBe(true);
    });

    await test.step("the pipeline's page: its pipeline.yml and its builds", async () => {
      await page.getByRole("navigation", { name: "Where you are" }).getByRole("link", { name: "web-ci" }).click();
      await expect(page).toHaveURL(`${BASE}/${full}/ci/web-ci`);
      await expect(page.getByText("command: npm test")).toBeVisible();
      await expect(page.getByRole("list", { name: "Builds" }).getByRole("link")).toHaveCount(2);
      // New build: the default branch's head, with fresh tokens, as Rebuild does.
      await page.getByRole("button", { name: "New build" }).click();
      await expect(page).toHaveURL(`${BASE}/${full}/ci/web-ci/101`, { timeout: 30_000 });
      expect(buildkite().created.at(-1)?.branch).toBe("main");
      await page.goBack();
    });

    await test.step("the CI tab: a build that moves while it is open changes in place, with the arrival", async () => {
      await page.goto(`${BASE}/${full}/ci`);
      const builds = page.getByRole("list", { name: "Recent builds" });
      const rebuilt = builds.getByRole("listitem").filter({ hasText: "#100" });

      await expect(builds.getByRole("listitem").filter({ hasText: "#7" }).getByText("failed", { exact: true })).toBeVisible();
      await expect(rebuilt.getByText("running", { exact: true })).toBeVisible();
      await page.waitForTimeout(2000);
      ciReads.from();
      await buildkite().send("build.finished", "web-ci", 100, { commit: sha, branch: "feature", message: "Start a feature", state: "canceled", finished_at: at(0) });
      await expect(rebuilt.getByText("canceled", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(rebuilt).toHaveClass(/arrived/);
      expect(ciReads.seen()).toEqual([]);
    });

    await test.step("a check on a commit no branch is at names the commit: lint passed on <sha>", async () => {
      const m = machine();
      const dir = m.commit("web", url, `side-${id}`, { "s1.txt": "1\n" }, "Side one");

      m.commit("web", url, `side-${id}`, { "s2.txt": "2\n" }, "Side two");
      m.push(dir, url, `side-${id}`);
      const first = m.git(dir, "rev-parse", "HEAD~1").trim();

      await page.goto(`${BASE}/${full}/activity`);
      await ciStatus(m, full, "projects-web", first, "lint", "success");
      const line = page.getByTestId("activity").getByRole("listitem").filter({ hasText: "lint" }).first();

      await expect(line.getByText("passed on", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(line.getByText(first.slice(0, 7), { exact: true })).toBeVisible();
    });

    await test.step("a broken .pando/pando.toml: the branch says its required checks are unknown, and why; only Merge anyway", async () => {
      const m = machine();
      const meta = `${BASE}/${full}/meta.git`;

      // The meta layer's first push of main (a save there is refused: .pando/ changes only through git), with a missing comma.
      m.push(m.commit("meta", meta, "main", { ".pando/pando.toml": '[repos."projects/web"]\nrequired_checks = ["ci" "e2e"]\n' }, "Require checks, badly"), meta, "main");
      await page.goto(`${BASE}/${full}/projects/web/branches/feature`);
      // ci is queued again after its Retry, so the box leads with it; the reason follows.
      await expect(page.getByText(/^Required checks unknown: pando\.toml line \d+: .+/)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("complementary").getByText("Required checks unknown", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Merge anyway" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0);
      await page.goto(`${BASE}/${full}/projects/web/branches`);
      // Its state word in the list (ci running, here) carries the reason as its title.
      const state = page.getByRole("list", { name: "Open branches" }).getByRole("link", { name: /feature/ }).locator("[title]");

      await expect(state).toHaveAttribute("title", /^Required checks unknown: pando\.toml line \d+: /);
    });

    await test.step("rename: the monorepo answers at its new name, and the old name redirects there", async () => {
      await page.goto(`${BASE}/${full}/settings`);
      await page.getByRole("textbox", { name: "Name" }).fill(renamed);
      await page.getByRole("button", { name: "Rename" }).click();
      await expect(page).toHaveURL(`${BASE}/${login}/${renamed}/settings`);
      made.name = renamed;
      await page.goto(`${BASE}/${full}/members`);
      await expect(page).toHaveURL(`${BASE}/${login}/${renamed}/members`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(`${login}/${renamed}`);
    });

    await test.step("delete: only the full owner/name typed out enables it", async () => {
      await page.goto(`${BASE}/${login}/${renamed}/settings`);
      const confirm = page.getByRole("textbox", { name: `Type ${login}/${renamed} to delete` });
      const del = page.getByRole("button", { name: `Delete ${login}/${renamed}` });

      await expect(del).toBeDisabled();
      await confirm.fill(renamed);
      await expect(del).toBeDisabled();
      await confirm.fill(`${login}/${renamed}`);
      await del.click();
      await expect(page).toHaveURL(`${BASE}/`);
      expect((await machine().api("GET", `/v1/monorepos/${login}/${renamed}`)).status).toBe(404);
      made.name = "";
    });

    expect(errors).toEqual([]);
  } finally {
    made.socket?.close();
    await made.buildkite?.close();

    if (made.name) await made.machine?.api("DELETE", `/v1/monorepos/${login}/${made.name}?confirm=${login}/${made.name}`);

    for (const other of made.others) await made.machine?.api("DELETE", `/v1/monorepos/${login}/${other}?confirm=${login}/${other}`);
  }
});
