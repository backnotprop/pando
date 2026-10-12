// Slice 9, end to end: a page for a single commit. A branch's commits open
// it: the title and message, the author and co-author, the branch it came
// from, its check with the Buildkite mark (reported on that bare commit, not
// the branch's head) and the files it changed in the diff view. A short sha
// in the address opens it too; an unknown one says so. A parent opens its own
// page (the first commit, compared with nothing); a session's commit opens
// its page; after the merge, the merge commit's page names the branch it
// merges, from the branch's Merge box and from main's history. Dark and
// light, 1440 and 390 wide, with nothing running off a phone's screen. Real
// Worker, real git, a real browser.
import { expect, type Page, test } from "@playwright/test";
import { join } from "node:path";
import { BASE, browserPost, ciStatus, HARD_LOAD, Machine, nextSignIn } from "./seed";
import { naming, recordSession } from "./sessions-seed";

const id = Date.now().toString(36);

const login = `cm-${id}`;

const name = `e2e-${id}`;

const full = `${login}/${name}`;

const person = { id: `user_cm_${id}`, email: `${login}@pando.invalid`, email_verified: true, first_name: "Commit", last_name: "Page" };

const project = `${BASE}/${full}/projects/web`;

const api = `/v1/monorepos/${full}/repos/projects-web`;

/** The shots, for a look (gitignored). */
const SHOTS = join(import.meta.dirname, "shots", "commit");

const short = (sha: string) => sha.slice(0, 7);

/** The diff view's lines (Pierre's, in its shadow root) holding `text`. */
const diffLine = (page: Page, text: string) => page.locator("diffs-container [data-line]").filter({ hasText: text }).first();

interface Made {
  machine: Machine | null;
}

test("slice 9: a commit's page from a branch, a short sha, a parent, a session and main's history; its checks and its diff", async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|404|409|412)/.test(m.text())) errors.push(m.text());
  });

  const made: Made = { machine: null };

  try {
    await nextSignIn(person);
    await page.goto("/login");
    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${BASE}/`);

    let first = "";
    let two = "";
    let three = "";
    let session = "";

    await test.step("a project requiring e2e, main, and a branch of two commits, one naming a recorded session", async () => {
      await browserPost(page, "/v1/monorepos", { name });
      const url = (await browserPost(page, `/v1/monorepos/${full}/repos`, { path: "projects/web" })).clone_url;
      // Named as the person's login, so its commits' email (<machine>@pando.invalid) is the person's: the page links them.
      const made_ = await browserPost(page, "/v1/user/credentials", { name: login, kind: "machine" });
      const m = new Machine(made_.secret, login, "Commit Page");

      made.machine = m;
      const meta = `${BASE}/${full}/meta.git`;

      m.push(m.commit("meta", meta, "main", { ".pando/pando.toml": '[repos."projects/web"]\nrequired_checks = ["e2e"]\n' }, "Require e2e"), meta, "main");
      let dir = m.commit("web", url, "main", { "README.md": "# web\n", "src/a.ts": "export const a = 1;\n" }, "Start the web project");

      m.push(dir, url, "main");
      first = m.git(dir, "rev-parse", "HEAD").trim();
      session = (await recordSession(made_.secret, full, "pi", `pi-commit-${id}`, { repo: "projects-web", branch: "feature" }, 60_000)).id;
      dir = m.commit("web", url, "feature", { "src/a.ts": "export const a = 2;\n" }, "Two is better\n\nOne was too few for the sum.\n\nCo-authored-by: Bo Lane <bo@pando.invalid>");
      two = m.git(dir, "rev-parse", "HEAD").trim();
      m.commit("web", url, "feature", { "src/b.ts": "export const b = 3;\n" }, naming("Add b", session));
      three = m.git(dir, "rev-parse", "HEAD").trim();
      m.push(dir, url, "feature");
      // A check on the first of the two, not the branch's head: the commit's page shows it.
      await ciStatus(m, full, "projects-web", two, "e2e", "success");
      // The branch's facts name it as the commit's branch, and link the session's commit.
      await expect.poll(async () => (await (await page.request.get(`${api}/commits/${two}`)).json()).branch?.name, { timeout: 60_000 }).toBe("feature");
      await expect.poll(async () => ((await (await page.request.get(`/v1/monorepos/${full}/sessions/${session}`)).json()).commits ?? []).length, { timeout: 60_000 }).toBe(1);
    });

    await test.step("a branch's commit opens its page: message, author, branch, its check with the Buildkite mark, the diff", async () => {
      await page.goto(`${project}/branches/feature`);
      await page.getByRole("list", { name: "Commits" }).getByRole("link", { name: short(two) }).click();
      await expect(page).toHaveURL(`${project}/commit/${two}`);
      await expect(page.getByRole("heading", { level: 1, name: "Two is better" })).toBeVisible(HARD_LOAD);
      await expect(page.getByText("One was too few for the sum.")).toBeVisible();
      await expect(page.locator("main").getByRole("link", { name: "Commit Page", exact: true })).toHaveAttribute("href", `/${login}`);
      await expect(page.getByText("and Bo Lane")).toBeVisible();
      await expect(page.locator("main").getByText(/^committed /)).toBeVisible();
      await expect(page.locator("main").getByRole("link", { name: "feature", exact: true })).toHaveAttribute("href", `/${full}/projects/web/branches/feature`);
      await expect(page.getByText(two, { exact: true })).toBeVisible();
      const check = page.getByRole("list", { name: "Checks" }).getByRole("listitem").filter({ hasText: "e2e" });

      await expect(check).toContainText("passed");
      await expect(check.getByRole("img", { name: "Buildkite" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Files changed" }).getByRole("link", { name: "src/a.ts" })).toBeVisible();
      await expect(diffLine(page, "export const a = 2;")).toBeVisible();
      await expect(diffLine(page, "export const a = 1;")).toBeVisible();
      // One file changed: the other commit's file is not here.
      await expect(page.getByRole("region", { name: "Files changed" }).getByRole("link", { name: "src/b.ts" })).toHaveCount(0);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
      await page.getByRole("button", { name: "Copy sha" }).click();
      await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(two);
    });

    await test.step("the shots: dark and light, 1440 and 390, nothing past a phone's edge", async () => {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });

        for (const mode of ["dark", "light"] as const) {
          await page.goto(`${project}/commit/${two}?theme=pando-${mode}`);
          await expect(diffLine(page, "export const a = 2;")).toBeVisible(HARD_LOAD);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          await page.screenshot({ path: join(SHOTS, `commit-${mode}-${width}.png`) });
        }
      }

      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await test.step("a short sha in the address opens the same page; an unknown one says there is none", async () => {
      await page.goto(`${project}/commit/${short(two)}`);
      await expect(page.getByRole("heading", { level: 1, name: "Two is better" })).toBeVisible(HARD_LOAD);
      await page.goto(`${project}/commit/0000000`);
      await expect(page.getByRole("heading", { level: 1, name: "No commit 0000000 in projects/web." })).toBeVisible(HARD_LOAD);
      await expect(page.getByRole("link", { name: "Back to the code" })).toHaveAttribute("href", `/${full}/projects/web`);
      await page.screenshot({ path: join(SHOTS, "no-commit-1440.png") });
    });

    await test.step("a parent opens its page: the first commit, compared with nothing", async () => {
      await page.goto(`${project}/commit/${two}`);
      await page.getByRole("link", { name: short(first) }).click();
      await expect(page).toHaveURL(`${project}/commit/${first}`);
      await expect(page.getByRole("heading", { level: 1, name: "Start the web project" })).toBeVisible(HARD_LOAD);
      await expect(page.getByText("No parent: the first commit")).toBeVisible();
      await expect(diffLine(page, "# web")).toBeVisible();
    });

    await test.step("a session's commit opens its page", async () => {
      await page.goto(`/${full}/sessions/${session}`);
      await page.getByRole("list", { name: "Its commits" }).getByRole("link", { name: short(three) }).click();
      await expect(page).toHaveURL(`${project}/commit/${three}`);
      await expect(page.getByRole("heading", { level: 1, name: "Add b" })).toBeVisible(HARD_LOAD);
      await expect(diffLine(page, "export const b = 3;")).toBeVisible();
    });

    await test.step("after the merge: the Merge box and main's history open the merge commit, which names its branch", async () => {
      const head = (await (await page.request.get(`${api}/branches/feature`)).json()).head;
      const merged = await browserPost(page, `${api}/branches/feature/merge?force=1`, { expected_head: head });

      await page.goto(`${project}/branches/feature`);
      await page.getByRole("link", { name: short(merged.sha) }).click();
      await expect(page).toHaveURL(`${project}/commit/${merged.sha}`);
      await expect(page.getByText("Merge of feature into main.")).toBeVisible(HARD_LOAD);
      await expect(page.getByText("Parents")).toBeVisible();
      await page.goto(`${project}/history/src/a.ts`);
      await page.getByRole("link", { name: short(merged.sha) }).click();
      await expect(page).toHaveURL(`${project}/commit/${merged.sha}`);
      await expect(page.getByText("Merge of feature into main.")).toBeVisible(HARD_LOAD);
      // The merged branch's own commit now says where it landed.
      await page.goto(`${project}/commit/${two}`);
      await expect(page.locator("main").getByText(/merged into main in/)).toBeVisible(HARD_LOAD);
    });

    expect(errors).toEqual([]);
  } finally {
    await made.machine?.api("DELETE", `/v1/monorepos/${full}?confirm=${full}`);
  }
});
