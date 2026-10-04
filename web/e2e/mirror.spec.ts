// Mirror to GitHub, end to end, against GitHub's stand-in
// (worker/test/git-standin.mjs: real git over bare repositories, GitHub's REST
// calls, and its authorize and install pages, which approve at once). The
// switch opens the dialog; Continue on GitHub installs the app; the match step
// is pre-filled by name; the mode choice; Change and Create; Start mirroring
// (through GitHub once more, to create); the statuses arriving live; Details
// (the commit sent, Change, a project's switch); the section's switch off and
// on; a row in trouble with Retry; then at 390: the rows, Disconnect, and the
// dialog as a sheet. Real Worker, real git, real browser.
//
//   PANDO_E2E_WORKER_PORT=8841 PANDO_E2E_STANDIN_PORT=8842 PANDO_E2E_INSPECTOR_PORT=9331 \
//   PANDO_E2E_GITHUB_PORT=8836 npx playwright test --project=mirror
import { createPublicKey } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { GITHUB_PORT } from "./ports.ts";
import { BASE, browserPost, HARD_LOAD, Machine, nextSignIn, saveRootFiles } from "./seed";

/** What this spec uses of the stand-in (worker/test/git-standin.mjs). */
interface GitStandin {
  addRepo: (installation: number, full: string, priv?: boolean) => { id: number; full_name: string };
  git: (full: string, ...args: string[]) => { stdout: string; status: number | null };
  fail: (path: RegExp, status: number, times?: number) => void;
  close: () => Promise<void>;
}

type StartGitStandin = (port: number, options: { publicKey: string; callback: string }) => Promise<GitStandin>;

/** Imported by path at run time: a .mjs with no types of its own. */
const STANDIN_MODULE = new URL("../../worker/test/git-standin.mjs", import.meta.url).href;

const id = Date.now().toString(36);

const login = `mirror-${id}`;

const name = `e2e-${id}`;

const full = `${login}/${name}`;

/** The GitHub account the stand-in's person installs the app on. */
const account = "backnotprop";

/** The installation the stand-in makes at the first install. */
const installation = 100;

const person = { id: `user_mirror_${id}`, email: `${login}@pando.invalid`, email_verified: true, first_name: "Mirror", last_name: "Lane" };

/** A run reaches GitHub within the spacing (1 s here) plus a fetch from Artifacts and a push. */
const RUN = { timeout: 60_000 };

const section = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Mirror to GitHub" }) });

const sectionSwitch = (page: Page) => section(page).getByRole("switch", { name: "Mirror to GitHub" });

const rows = (page: Page) => section(page).getByRole("list", { name: "Mirror to GitHub" });

const row = (page: Page, label: string) => rows(page).getByRole("listitem").filter({ has: page.getByText(label, { exact: true }) });

/** The setup dialog (named by its step's title); while it is open the page behind it is hidden from the accessibility tree. */
const dialog = (page: Page) => page.getByRole("dialog");

const matchRow = (page: Page, label: string) => dialog(page).getByRole("list", { name: "Match" }).getByRole("listitem").filter({ has: page.getByText(label, { exact: true }) });

/** Picks `item` in a row's Change menu. */
async function change(page: Page, where: Locator, item: string | RegExp) {
  await where.getByRole("button", { name: "Change" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

const box = async (l: Locator) => {
  const b = await l.boundingBox();

  if (!b) throw new Error("not on screen");

  return b;
};

test("mirror to GitHub: connect, match, create, live statuses, details, pause, retry, phone", async ({ page }) => {
  test.setTimeout(420_000);

  if (!GITHUB_PORT || !process.env.PANDO_E2E_GITHUB_KEY) throw new Error("set PANDO_E2E_GITHUB_PORT (playwright.config.ts makes the key)");
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|404|409)/.test(m.text())) errors.push(m.text());
  });

  // SAFETY: worker/test/git-standin.mjs exports startGitStandin(port, { publicKey, callback }), answering the object GitStandin describes.
  const { startGitStandin } = (await import(STANDIN_MODULE)) as { startGitStandin: StartGitStandin };
  const publicKey = createPublicKey(process.env.PANDO_E2E_GITHUB_KEY).export({ type: "spki", format: "pem" }).toString();
  const github = await startGitStandin(GITHUB_PORT, { publicKey, callback: `${BASE}/v1/github/callback` });
  let machine: Machine | null = null;
  let created = false;

  const heads = { web: "", api: "" };

  /**
   * A change on a project's main, through Pando's git door: the first starts
   * main; after that main is protected, so it goes up a branch and merges, as
   * pando merge does. Answers main's new head.
   */
  const land = async (repo: "web" | "api", url: string, files: Record<string, string>, message: string) => {
    if (!machine) throw new Error("no machine yet");
    const branch = heads[repo] ? "work" : "main";
    const dir = machine.commit(repo, url, branch, files, message);

    machine.push(dir, url, branch);

    if (branch === "main") {
      heads[repo] = machine.git(dir, "rev-parse", "HEAD").trim();

      return heads[repo];
    }

    const res = await machine.api("POST", `/v1/monorepos/${full}/repos/projects-${repo}/branches/work/merge?force=1`, { expected_head: machine.git(dir, "rev-parse", "HEAD").trim() });

    if (!res.ok) throw new Error(`merge: ${res.status} ${await res.text()}`);
    const merged: { sha: string } = await res.json();

    heads[repo] = merged.sha;

    return heads[repo];
  };

  /** What GitHub's stand-in has on a repository's main. */
  const onGithub = (repo: string) => github.git(`${account}/${repo}`, "rev-parse", "--verify", "--quiet", "refs/heads/main").stdout.trim();

  try {
    await nextSignIn(person);
    await page.goto("/login");
    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${BASE}/`);

    const urls = { web: "", api: "" };

    await test.step("a monorepo with two projects on main, files outside projects/, and GitHub repositories", async () => {
      await browserPost(page, "/v1/monorepos", { name });
      created = true;
      urls.web = (await browserPost(page, `/v1/monorepos/${full}/repos`, { path: "projects/web" })).clone_url;
      urls.api = (await browserPost(page, `/v1/monorepos/${full}/repos`, { path: "projects/api" })).clone_url;
      machine = await Machine.make(page, `laptop-${id}`);
      await land("web", urls.web, { "README.md": "# web\n" }, "Start the web project");
      await land("api", urls.api, { "README.md": "# api\n" }, "Start the api project");
      await saveRootFiles(page, full, machine.name, { "NOTES.md": "# Notes\n" });
      // On GitHub: web exists (public), and one more (private) to pick in Change.
      github.addRepo(installation, `${account}/web`, false);
      github.addRepo(installation, `${account}/notes`, true);
    });

    await test.step("off: one line and one switch; the switch opens step 1", async () => {
      await page.goto(`/${full}/settings`);
      await expect(section(page).getByText("Mirror this repository's projects to GitHub.")).toBeVisible(HARD_LOAD);
      await expect(sectionSwitch(page)).toHaveAttribute("aria-checked", "false");
      await sectionSwitch(page).click();
      await expect(dialog(page).getByText("1 of 2")).toBeVisible();
      await expect(dialog(page).getByRole("heading", { name: "Connect GitHub" })).toBeVisible();
      // At 1440 it is a dialog in the middle, not a sheet.
      expect((await box(dialog(page))).width).toBe(480);

      // Cancel turns the switch back off.
      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      await expect(dialog(page)).toBeHidden();
      await expect(sectionSwitch(page)).toHaveAttribute("aria-checked", "false");
    });

    await test.step("Continue on GitHub: the app installs, and the dialog comes back at step 2, matched by name", async () => {
      await sectionSwitch(page).click();
      await dialog(page).getByRole("link", { name: "Continue on GitHub" }).click();
      await expect(dialog(page).getByText("2 of 2")).toBeVisible(HARD_LOAD);
      // The address loses ?mirror=match.
      await expect(page).toHaveURL(`${BASE}/${full}/settings`);
      await expect(matchRow(page, "web")).toContainText(`${account}/web`);
      await expect(matchRow(page, "web").getByRole("checkbox")).toHaveAttribute("aria-checked", "true");
      await expect(matchRow(page, "api")).toContainText(`Create ${account}/api`);
      await expect(matchRow(page, "Files outside projects/")).toContainText(`Create ${account}/${name}-files`);
      await expect(dialog(page).getByText(`${account}/web is public. Everything in its history will be public.`)).toBeVisible();
    });

    await test.step("the mode: the whole repository is one row; back to each project", async () => {
      await dialog(page).getByRole("radio", { name: "Whole repository" }).click();
      await expect(dialog(page).getByRole("list", { name: "Match" }).getByRole("listitem")).toHaveCount(1);
      await expect(matchRow(page, full)).toContainText(`Create ${account}/${name}`);
      await dialog(page).getByRole("radio", { name: "Each project" }).click();
      await expect(dialog(page).getByRole("list", { name: "Match" }).getByRole("listitem")).toHaveCount(3);
    });

    await test.step("Change: the installation's repositories, Create, and Add repositories on GitHub", async () => {
      await matchRow(page, "api").getByRole("button", { name: "Change" }).click();
      await expect(page.getByRole("menuitem", { name: /notes.*Private/ })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: /web.*Public/ })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Add repositories on GitHub" })).toHaveAttribute("href", new RegExp(`/settings/installations/${installation}$`));
      await page.getByRole("menuitem", { name: `${account}/notes` }).click();
      await expect(matchRow(page, "api")).toContainText(`${account}/notes`);
      await change(page, matchRow(page, "api"), `Create ${account}/api`);
      await expect(matchRow(page, "api")).toContainText(`Create ${account}/api`);
    });

    await test.step("Start mirroring: GitHub once more to create, then every row up to date", async () => {
      await dialog(page).getByRole("button", { name: "Start mirroring" }).click();
      await expect(rows(page)).toBeVisible(HARD_LOAD);
      await expect(dialog(page)).toBeHidden();
      await expect(sectionSwitch(page)).toHaveAttribute("aria-checked", "true");
      await expect(row(page, "web").getByRole("link", { name: `${account}/web` })).toHaveAttribute("target", "_blank");
      await expect(row(page, "api").getByRole("link", { name: `${account}/api` })).toBeVisible();

      for (const label of ["web", "api", "Files outside projects/"]) await expect(row(page, label)).toContainText(/Up to date · (now|\d+ s)/, RUN);

      expect(onGithub("web")).toBe(heads.web);
      expect(onGithub("api")).toBe(heads.api);
      expect(onGithub(`${name}-files`)).toMatch(/^[0-9a-f]{40}$/);
    });

    await test.step("a merge to main reaches GitHub, and the row says so live", async () => {
      const sha = await land("web", urls.web, { "src/app.ts": "export const app = 1;\n" }, "Add the app");

      await expect.poll(() => onGithub("web"), RUN).toBe(sha);
      await expect(row(page, "web")).toContainText(/Up to date/, RUN);
    });

    await test.step("Details: the commit sent, Change, a project's switch, the account", async () => {
      await section(page).getByRole("button", { name: "Details" }).click();
      await expect(row(page, "web").locator("code")).toHaveText(heads.web.slice(0, 7));
      await expect(section(page).getByText(account, { exact: true })).toBeVisible();
      await expect(section(page).getByRole("link", { name: "Manage on GitHub" })).toHaveAttribute("href", new RegExp(`/settings/installations/${installation}$`));

      // Change api to notes: saved, and sent there.
      await change(page, row(page, "api"), `${account}/notes`);
      await expect(row(page, "api").getByRole("link", { name: `${account}/notes` })).toBeVisible();
      await expect.poll(() => onGithub("notes"), RUN).toBe(heads.api);

      // api's own switch off: its row says Off, and stays Off with Details closed.
      await row(page, "api").getByRole("switch", { name: "Mirror api" }).click();
      await expect(row(page, "api").getByRole("switch", { name: "Mirror api" })).toHaveAttribute("aria-checked", "false");
      await expect(row(page, "api")).toContainText("Off");
      await section(page).getByRole("button", { name: "Details" }).click();
      await expect(row(page, "api")).toContainText("Off");
      await expect(row(page, "api").getByRole("link")).toHaveCount(0);
    });

    await test.step("the section's switch off pauses: rows say how far behind; on sends it", async () => {
      await sectionSwitch(page).click();
      await expect(sectionSwitch(page)).toHaveAttribute("aria-checked", "false");
      await expect(row(page, "web")).toContainText("Paused");
      await land("web", urls.web, { "src/b.ts": "export const b = 2;\n" }, "Add b");
      // A push while paused publishes nothing (mirror/out.ts dirty()), so the page reads again to see it.
      await page.reload();
      await expect(row(page, "web")).toContainText(/Paused · \d+ commits? behind/, RUN);
      expect(onGithub("web")).not.toBe(heads.web);

      await sectionSwitch(page).click();
      await expect(sectionSwitch(page)).toHaveAttribute("aria-checked", "true");
      await expect.poll(() => onGithub("web"), RUN).toBe(heads.web);
      await expect(row(page, "web")).toContainText(/Up to date/, RUN);
    });

    await test.step("a row in trouble: one sentence and Retry, on that row only", async () => {
      // GitHub answers 404 to the next run's first call for web: Not found.
      github.fail(new RegExp(`^/git/${account}/web\\.git/info/refs$`), 404, 1);
      const sha = await land("web", urls.web, { "src/c.ts": "export const c = 3;\n" }, "Add c");

      await expect(row(page, "web")).toContainText("Not found", RUN);
      await expect(row(page, "web").getByText("The repository is not on GitHub, or the Pando app was removed from it")).toBeVisible();
      await expect(row(page, "Files outside projects/").getByRole("button", { name: "Retry" })).toHaveCount(0);
      await row(page, "web").getByRole("button", { name: "Retry" }).click();
      await expect.poll(() => onGithub("web"), RUN).toBe(sha);
      await expect(row(page, "web")).toContainText(/Up to date/, RUN);
      await expect(row(page, "web").getByRole("button", { name: "Retry" })).toHaveCount(0);
    });

    await test.step("390: the status beside the source, the GitHub repository on the line under it", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const web = row(page, "web");
      const source = await box(web.getByText("web", { exact: true }));
      const status = await box(web.getByText(/Up to date/));
      const link = await box(web.getByRole("link", { name: `${account}/web` }));

      expect(Math.abs(status.y - source.y)).toBeLessThan(6);
      expect(status.x).toBeGreaterThan(source.x);
      expect(link.y).toBeGreaterThan(source.y + source.height - 2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    });

    await test.step("390, Details: Disconnect asks once more, and GitHub is left as it was", async () => {
      await section(page).getByRole("button", { name: "Details" }).click();
      await section(page).getByRole("button", { name: "Disconnect" }).click();
      await section(page).getByRole("button", { name: "Disconnect GitHub" }).click();
      await expect(section(page).getByText("Mirror this repository's projects to GitHub.")).toBeVisible();
      await expect(sectionSwitch(page)).toHaveAttribute("aria-checked", "false");
      expect(onGithub("web")).toBe(heads.web);
    });

    await test.step("390: the dialog is a sheet from the bottom; Escape leaves the switch off", async () => {
      await sectionSwitch(page).click();
      // It slides up from the bottom edge, full width.
      await expect.poll(async () => Math.round((await box(dialog(page))).y + (await box(dialog(page))).height)).toBe(844);
      expect((await box(dialog(page))).width).toBe(390);
      // The installation is still this person's: GitHub returns at once, to step 2.
      await dialog(page).getByRole("link", { name: "Continue on GitHub" }).click();
      await expect(dialog(page).getByText("2 of 2")).toBeVisible(HARD_LOAD);
      await expect(matchRow(page, "web")).toContainText(`${account}/web`);
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toBeHidden();
      await expect(sectionSwitch(page)).toHaveAttribute("aria-checked", "false");
    });

    expect(errors).toEqual([]);
  } finally {
    if (created) await page.request.delete(`/v1/monorepos/${full}`, { headers: { origin: BASE } }).catch(() => null);
    await github.close();
  }
});
