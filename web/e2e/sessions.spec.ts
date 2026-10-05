// Recorded agent sessions in the web, end to end (sessions lane, stage 4): the real Worker, its D1, Durable Objects
// and R2, real git through the door, sessions appended from the recorded fixtures through machine credentials, in a
// real browser. The story: ramos/pando with projects/pando; ramos's Pi and OpenCode sessions on refresh-margin
// (merged, with #1 linked) and in the repository folder; ana's active Pi session on rate-limit; one from yesterday.
//
//   npx playwright test --project=sessions          the checks
//   PANDO_SF_FONTS=1 npx playwright test --project=sessions-shots   the built pages, into
//   research/design/pando-ui-2026-10-03/sessions/built/ (dark and light, 1440 and 390), for the owner's look
import { type Browser, expect, type Page, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, browserPost, type JsonBody, Machine, nextSignIn } from "./seed";
import { naming, recordSession } from "./sessions-seed";

const person = (login: string, first: string, last: string) => ({ id: `user_${login}_local`, email: `${login}@pando.invalid`, email_verified: true, first_name: first, last_name: last });

const ramos = person("ramos", "Michael", "Ramos");

const ana = person("ana", "Ana", "Lopes");

const H = 3_600_000;

async function signIn(page: Page, who: typeof ramos) {
  await nextSignIn(who);
  await page.goto(`${BASE}/login`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
}

async function send(page: Page, method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, data?: JsonBody) {
  const res = await page.request.fetch(path, { method, data, headers: { origin: BASE } });

  if (!res.ok() && res.status() !== 409) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);

  return res;
}

/** A machine credential for the signed-in person, and its secret (to append sessions as `pando sync` does). */
async function machine(page: Page, name: string, author: string): Promise<{ m: Machine; secret: string }> {
  const made = await browserPost(page, "/v1/user/credentials", { name, kind: "machine" });

  return { m: new Machine(made.secret, name, author), secret: made.secret };
}

interface Story {
  full: string;
  s1: string;
  s4: string;
  folder: string;
  /** In the repository folder, with no commits. */
  quiet: string;
  anaActive: string;
}

async function seed(page: Page, browser: Browser): Promise<Story> {
  const full = "ramos/pando";
  await page.request.delete(`/v1/monorepos/${full}?confirm=${full}`, { headers: { origin: BASE } });
  await browserPost(page, "/v1/monorepos", { name: "pando", kind: "monorepo" });
  const url = (await browserPost(page, `/v1/monorepos/${full}/repos`, { path: "projects/pando" })).clone_url;
  const anaContext = await browser.newContext();
  const anaPage = await anaContext.newPage();

  await signIn(anaPage, ana);
  await send(page, "PUT", `/v1/monorepos/${full}/members/ana`, { role: "member" });
  const sandbox = await machine(page, "sandbox-1", "Michael Ramos");
  const anaMbp = await machine(anaPage, "ana-mbp", "Ana Lopes");
  const where = (branch: string | null) => ({ repo: branch ? "projects-pando" : null, branch });

  const s1 = await recordSession(sandbox.secret, full, "pi", "pi-refresh-1", where("refresh-margin"), 3 * H);
  const s4 = await recordSession(sandbox.secret, full, "opencode", "ses_refresh_2", where("refresh-margin"), 2 * H);
  const folder = await recordSession(sandbox.secret, full, "opencode", "ses_folder_1", where(null), 5 * H);
  const quiet = await recordSession(sandbox.secret, full, "opencode", "ses_folder_2", where(null), 6 * H);
  const anaActive = await recordSession(anaMbp.secret, full, "pi", "pi-rate-1", where("rate-limit"), 2 * 60_000);

  await recordSession(sandbox.secret, full, "pi", "pi-docs-1", where("docs-sync"), 26 * H);

  sandbox.m.push(sandbox.m.commit("pando", url, "main", { "README.md": "# pando\n" }, "First"), url, "main");
  const dir = sandbox.m.commit("pando", url, "refresh-margin", { "web/client.ts": "export const margin = 60;\n" }, naming("Refresh the token before the request", s1.id));

  sandbox.m.commit("pando", url, "refresh-margin", { "web/refresh.e2e.ts": "test('refresh');\n" }, naming("e2e: sign in with a 30 s token", s4.id));
  sandbox.m.commit("pando", url, "refresh-margin", { "web/client.ts": "export const margin = 60;\nexport const retry = 1;\n" }, naming("Retry once after a 401 that follows a refresh", s1.id));
  sandbox.m.push(dir, url, "refresh-margin");
  await send(page, "POST", `/v1/monorepos/${full}/issues`, { title: "Users get signed out mid-merge", link: [{ repo: "projects-pando", branch: "refresh-margin" }] });
  // An open branch: two sessions name its commits, one commit names none.
  const tc = sandbox.m.commit("pando", url, "theme-cache", { "web/theme.ts": "export const cache = 1;\n" }, naming("Cache the theme", folder.id));

  sandbox.m.commit("pando", url, "theme-cache", { "web/theme.md": "cache\n" }, "Say why the theme is cached");
  sandbox.m.commit("pando", url, "theme-cache", { "web/theme.ts": "export const cache = 2;\n" }, naming("Clear the cache on a theme change", folder.id, anaActive.id));
  sandbox.m.push(tc, url, "theme-cache");
  anaMbp.m.push(anaMbp.m.commit("pando", url, "rate-limit", { "web/rate.ts": "export const limit = 10;\n" }, naming("Limit retries", anaActive.id)), url, "rate-limit");
  await expect.poll(async () => ((await (await page.request.get(`/v1/monorepos/${full}/sessions/${s1.id}`)).json()).commits ?? []).length, { timeout: 60_000 }).toBe(2);
  await send(page, "POST", `/v1/monorepos/${full}/repos/projects-pando/branches/refresh-margin/merge?force=1`);
  await expect.poll(async () => ((await (await page.request.get(`/v1/monorepos/${full}/sessions/${s1.id}`)).json()).commits ?? []).filter((c: { on_main: boolean }) => c.on_main).length, { timeout: 90_000 }).toBe(2);
  // What each machine last said about its recording, as `pando sync` reports it.
  await sandbox.m.api("PUT", "/v1/user/session-machine", { recording: true, stores: [{ program: "pi", path: "/home/ramos/.pi/agent/sessions", found: "default" }, { program: "claude-code", path: "/home/ramos/work/claude-b/projects", found: "commit hook" }] });
  await anaContext.close();

  return { full, s1: s1.id, s4: s4.id, folder: folder.id, quiet: quiet.id, anaActive: anaActive.id };
}

let story: Story | null = null;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await signIn(page, ramos);
  story = await seed(page, browser);
  await context.close();
});

test.beforeEach(async ({ page }) => {
  await signIn(page, ramos);
});

test("the Sessions tab: one line per session under day headers, Active and Inactive, filters", async ({ page }) => {
  const s = story!;

  await page.goto(`/${s.full}/sessions`);
  await expect(page.getByRole("link", { name: /^Sessions/ })).toHaveAttribute("aria-current", "page");
  const today = page.getByRole("list", { name: "Today" });
  const row = today.locator(`li[data-session="${s.s1}"]`);

  await expect(row).toContainText("refresh-margin");
  await expect(row).toContainText("#1");
  await expect(row).toContainText("Pi, GPT-5.5");
  await expect(row).toContainText("ramos");
  await expect(row).toContainText("2 commits, 2 on main");
  await expect(today.locator(`li[data-session="${s.quiet}"]`)).toContainText("repository folder");
  await expect(today.locator(`li[data-session="${s.quiet}"]`)).toContainText("no commits");
  // A session that ran in the repository folder leads with the branch its commits are on (DETERMINISM.md row 23).
  await expect(today.locator(`li[data-session="${s.folder}"]`)).toContainText("theme-cache");
  await expect(today.locator(`li[data-session="${s.anaActive}"]`)).toContainText(/active · \d+ min ago/);
  await expect(page.getByRole("list", { name: "Yesterday" })).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "State" }).getByRole("link", { name: /Active/ })).toContainText("1");
  await page.getByRole("navigation", { name: "State" }).getByRole("link", { name: /Active/ }).click();
  await expect(page.locator("li[data-session]")).toHaveCount(1);
  await page.goto(`/${s.full}/sessions?agent=opencode`);
  await expect(page.locator("li[data-session]")).toHaveCount(3);
  await page.goto(`/${s.full}/sessions?main=yes`);
  await expect(page.locator("li[data-session]")).toHaveCount(2);
  await page.goto(`/${s.full}/sessions?group=branch`);
  await expect(page.getByRole("list", { name: "refresh-margin" }).locator("li[data-session]")).toHaveCount(2);
});

test("a session's page: header, its commits with their own checks, files in its commits, delete asked once", async ({ page }) => {
  const s = story!;

  await page.goto(`/${s.full}/sessions`);
  await page.locator(`li[data-session="${s.s1}"] > a`).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Session on refresh-margin");
  await expect(page.getByText("on sandbox-1")).toBeVisible();
  const commits = page.getByRole("list", { name: "Its commits" });

  await expect(commits.getByRole("listitem")).toHaveCount(2);
  await expect(commits.getByRole("listitem").first()).toContainText("Refresh the token before the request");
  await expect(commits.getByRole("listitem").first()).toContainText("no checks on this commit");
  await expect(page.getByRole("region", { name: "Files in its commits" })).toContainText("projects/pando/web/client.ts");
  await page.getByRole("button", { name: "Delete session" }).click();
  await expect(page.getByText("Delete this session?")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Delete session" }).click();
  await expect(page).toHaveURL(new RegExp(`/${s.full}/sessions$`));
  await expect(page.locator(`li[data-session="${s.s1}"]`)).toHaveCount(0);
  await page.goto(`/${s.full}/sessions/${s.s1}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Session deleted");
  await expect(page.getByText(/Deleted by ramos/)).toBeVisible();
  await expect(page.getByRole("list", { name: "Its commits" }).getByRole("listitem")).toHaveCount(2);
});

test("the profile: the graph's agents by week and by day, the latest sessions, and /ramos/sessions", async ({ page }) => {
  const s = story!;

  await page.goto("/ramos");
  const graph = page.getByRole("region", { name: "Contributions" });

  await expect(graph.getByRole("radiogroup", { name: "Show agents" })).toBeVisible();
  await expect(graph.getByRole("img", { name: "OpenCode" }).first()).toBeVisible();
  await graph.getByRole("radio", { name: "By day" }).click();
  await expect(graph.getByText("Each day's agent sits on its square")).toBeVisible();
  await page.reload();
  await expect(graph.getByRole("radio", { name: "By day" })).toHaveAttribute("aria-checked", "true");
  await graph.getByRole("radio", { name: "By week" }).click();
  const sessions = page.getByRole("region", { name: "Sessions" });

  await expect(sessions.locator("li[data-session]")).toHaveCount(4);
  await sessions.getByRole("link", { name: /^All \d+/ }).click();
  await expect(page).toHaveURL(/\/ramos\/sessions$/);
  await expect(page.locator(`li[data-session="${s.folder}"]`)).toContainText("ramos/pando");
  await page.getByRole("button", { name: /ramos/ }).first().click();
  await expect(page.getByRole("menuitem", { name: "Your sessions" })).toBeVisible();
});

test("a branch: each commit's session numbers on the Overview, and its Sessions tab", async ({ page }) => {
  const s = story!;

  await page.goto(`/${s.full}/projects/pando/branches/theme-cache`);
  const commits = page.getByRole("list", { name: "Commits" });

  await expect(commits.getByRole("listitem").filter({ hasText: "Clear the cache on a theme change" }).getByLabel("Session 1 and 2")).toBeVisible();
  await expect(commits.getByRole("listitem").filter({ hasText: "Cache the theme" }).getByLabel("Session 1")).toBeVisible();
  await expect(commits.getByRole("listitem").filter({ hasText: "Say why the theme is cached" }).getByLabel(/^Session/)).toHaveCount(0);
  await page.getByRole("link", { name: /^Sessions/ }).click();
  const list = page.getByRole("list", { name: "Sessions on this branch" });

  await expect(list.locator(`[data-branch-session="${s.folder}"]`)).toContainText("Session 1");
  await expect(list.locator(`[data-branch-session="${s.anaActive}"]`)).toContainText("Session 2");
  await expect(list.locator(`[data-branch-session="${s.folder}"]`)).toContainText("2 commits");
  await expect(list.locator(`[data-branch-session="${s.folder}"]`)).not.toContainText("on main");
  await list.locator(`[data-branch-session="${s.folder}"]`).getByRole("button", { name: /2 commits/ }).click();
  await expect(list.getByRole("list", { name: "Its commits on this branch" }).first()).toContainText("no checks on this commit");
  await expect(page.getByText(/No session recorded:/)).toContainText("Say why the theme is cached");
});

test("Settings: recording per machine, not recorded, data folders, delete sessions", async ({ page }) => {
  const s = story!;

  await page.goto("/settings/sessions");
  await expect(page.getByRole("region", { name: "Recording" })).toContainText("sandbox-1");
  await expect(page.getByRole("region", { name: "Recording" })).toContainText(/On · reported/);
  await expect(page.getByRole("region", { name: "Data folders" })).toContainText("/home/ramos/work/claude-b/projects");
  await page.getByRole("button", { name: "Add a repository or project" }).click();
  await page.getByRole("combobox", { name: "Project" }).selectOption("projects/pando");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const notRecorded = page.getByRole("region", { name: "Not recorded" });

  await expect(notRecorded).toContainText("projects/pando");
  await expect(notRecorded).toContainText("One project");
  await notRecorded.getByRole("button", { name: "Remove" }).click();
  await expect(notRecorded).not.toContainText("One project");
  const del = page.getByRole("region", { name: "Delete sessions" });

  await del.getByRole("combobox", { name: "Age" }).selectOption("");
  await expect(del.getByRole("button", { name: /Delete \d+ sessions?/ })).toBeVisible();
  await del.getByRole("button", { name: /Delete \d+ sessions?/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(del.getByRole("button", { name: /Delete/ })).toBeDisabled();
  await page.goto(`/${s.full}/sessions`);
  await expect(page.locator("li[data-session]")).toHaveCount(1);
});

const SHOTS = join(import.meta.dirname, "../../../../../../research/design/pando-ui-2026-10-03/sessions/built");

test("shots of the built pages, for the owner's look", async ({ page }) => {
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  const notes: Record<string, string> = {};
  const s = story!;

  const settle = async () => {
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(700);
  };

  // The stub: the repository-folder session, deleted for the shot.
  await send(page, "DELETE", `/v1/monorepos/${s.full}/sessions/${s.folder}`);

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });

    for (const theme of ["pando-dark", "pando-light"]) {
      const shot = async (name: string, route: string, caption: string) => {
        await page.goto(`${route}${route.includes("?") ? "&" : "?"}theme=${theme}`);
        await settle();
        const file = `${name}-${theme}-${width}.png`;

        await page.screenshot({ path: join(SHOTS, file), fullPage: true });
        notes[file] = caption;
      };

      await shot("repo-sessions", `/${s.full}/sessions`, "The repository's Sessions tab");
      await shot("repo-sessions-by-branch", `/${s.full}/sessions?group=branch`, "Group: Branch");
      await shot("session", `/${s.full}/sessions/${s.s1}`, "A session's page (the conversation waits for the shared component)");
      await shot("session-deleted", `/${s.full}/sessions/${s.folder}`, "A deleted session's stub");
      await shot("profile-sessions", "/ramos", "The profile: the graph's agents by week, the latest sessions");
      await shot("person-sessions", "/ramos/sessions", "/ramos/sessions");
      await shot("settings-sessions", "/settings/sessions", "Settings, Sessions");
      await shot("branch-overview", `/${s.full}/projects/pando/branches/theme-cache`, "A branch's Overview: each commit's session numbers");
      await shot("branch-sessions", `/${s.full}/projects/pando/branches/theme-cache?tab=sessions`, "A branch's Sessions tab");
    }
  }

  writeFileSync(join(SHOTS, "shots.json"), `${JSON.stringify(notes, null, 2)}\n`);
});
