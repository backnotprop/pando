// Slice 2, end to end: a project's code on main and on a branch (the picker,
// the ahead line, a file, its history), its branches, a branch's page with its
// commits and co-authors, checks that Buildkite reports arriving live, a merge
// through the page, a branch left conflicting by that merge, and the
// monorepo's Activity tab taking a push live. Real Worker, real git.
import { expect, test } from "@playwright/test";
import { BASE, browserPost, ciStatus, Machine, nextSignIn } from "./seed";

const id = Date.now().toString(36);

const login = `br-${id}`;

const name = `e2e-${id}`;

const full = `${login}/${name}`;

const person = { id: `user_br_${id}`, email: `${login}@pando.invalid`, email_verified: true, first_name: "Branch", last_name: "Lane" };

const project = `${BASE}/${full}/projects/web`;

interface Made {
  machine: Machine | null;
}

test("slice 2: project code at a ref, branches, the pull request, checks, merge, conflicts, live activity", async ({ page }) => {
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|409|412)/.test(m.text())) errors.push(m.text());
  });

  const made: Made = { machine: null };

  const machine = () => {
    if (!made.machine) throw new Error("no machine credential yet");

    return made.machine;
  };

  try {
    await nextSignIn(person);
    await page.goto("/login");
    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${BASE}/`);

    let url = "";
    let feature = "";

    await test.step("a project with main, a branch with a co-author, and a branch that will clash", async () => {
      await browserPost(page, "/v1/monorepos", { name });
      url = (await browserPost(page, `/v1/monorepos/${full}/repos`, { path: "projects/web" })).clone_url;
      made.machine = await Machine.make(page, `laptop-${id}`);
      const m = machine();

      m.push(m.commit("web", url, "main", { "README.md": "# web\n\nThe web project.\n", "src/a.ts": "export const a = 1;\n" }, "Start the web project"), url, "main");
      const dir = m.commit("web", url, "feature", { "src/a.ts": "export const a = 2;\n" }, "Two is better\n\nCo-authored-by: Claude <noreply@anthropic.com>");

      m.push(dir, url, "feature");
      feature = m.git(dir, "rev-parse", "HEAD").trim();
      m.push(m.commit("web", url, "clash", { "src/a.ts": "export const a = 3;\n" }, "Three is better"), url, "clash");
    });

    await test.step("the project's code on main: its files and README", async () => {
      await page.goto(project);
      const files = page.getByRole("list", { name: "Files" });

      await expect(files.getByRole("link", { name: "README.md" })).toBeVisible();
      await expect(files.getByRole("link", { name: "src" })).toBeVisible();
      await expect(page.getByText("The web project.")).toBeVisible();
      await expect(page.getByRole("link", { name: "2 open branches" })).toBeVisible();
    });

    await test.step("the branch picker opens the same folder on a branch, with how far ahead it is", async () => {
      await page.getByRole("button", { name: "main" }).click();
      await page.getByRole("navigation", { name: "Branches" }).getByRole("link", { name: /feature/ }).click();
      await expect(page).toHaveURL(`${project}?ref=feature`);
      await expect(page.getByText("is 1 commit ahead of main.")).toBeVisible();
    });

    await test.step("a file on that branch, and its history", async () => {
      await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "src" }).click();
      await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "a.ts" }).click();
      await expect(page).toHaveURL(`${project}/blob/src/a.ts?ref=feature`);
      await expect(page.getByText("export const a = 2;")).toBeVisible();
      const raw = await page.request.get(String(await page.getByRole("link", { name: "Raw" }).getAttribute("href")));

      expect(raw.status()).toBe(200);
      expect(await raw.text()).toBe("export const a = 2;\n");
      await page.getByRole("link", { name: "History" }).click();
      await expect(page.getByText("Two is better")).toBeVisible();
      await expect(page.getByText("Start the web project")).toBeVisible();
    });

    await test.step("the branches list and the branch's page: commits with co-authors", async () => {
      await page.goto(`${project}/branches`);
      // Exactly one current tab per bar: Branches (not Code too), and Open.
      const repoTabs = page.getByRole("navigation", { name: "projects/web" }).locator('[aria-current="page"]');
      const listTabs = page.getByRole("navigation", { name: "Branches" }).locator('[aria-current="page"]');

      await expect(repoTabs).toHaveCount(1);
      await expect(repoTabs).toHaveText(/^Branches/);
      await expect(listTabs).toHaveCount(1);
      await expect(listTabs).toHaveText(/^Open/);
      const open = page.getByRole("list", { name: "Open branches" });

      await expect(open.getByRole("link", { name: /feature/ })).toBeVisible();
      await expect(open.getByRole("link", { name: /clash/ })).toBeVisible();
      // On a phone nothing runs past the screen (the worktree command fits, with its Copy).
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.setViewportSize({ width: 1440, height: 900 });
      await open.getByRole("link", { name: /feature/ }).click();
      await expect(page).toHaveURL(`${project}/branches/feature`);
      await expect(page.getByRole("list", { name: "Commits" }).getByText("Two is better")).toBeVisible();
      await expect(page.getByText("and Claude")).toBeVisible();
    });

    await test.step("a failing check reported by Buildkite arrives live: its mark, and Merge anyway", async () => {
      await ciStatus(machine(), full, "projects-web", feature, "e2e", "failure");
      await expect(page.getByText("e2e failed").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("img", { name: "Buildkite" }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Merge anyway" })).toBeVisible();
    });

    await test.step("the check passes, and Merge lands the branch", async () => {
      await ciStatus(machine(), full, "projects-web", feature, "e2e", "success");
      await expect(page.getByRole("button", { name: "Merge", exact: true })).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Merge", exact: true }).click();
      await expect(page.getByText("Merged into main")).toBeVisible({ timeout: 30_000 });
      await page.goto(`${project}/branches?tab=merged`);
      await expect(page.getByRole("navigation", { name: "Branches" }).locator('[aria-current="page"]')).toHaveCount(1);
      await expect(page.getByRole("navigation", { name: "Branches" }).locator('[aria-current="page"]')).toHaveText(/^Merged/);
      await expect(page.getByRole("list", { name: "Merged branches" }).getByRole("link", { name: /Two is better|feature/ })).toBeVisible();
    });

    await test.step("the clashing branch now conflicts with main, and Merge is off", async () => {
      await page.goto(`${project}/branches/clash`);
      await expect(page.getByText("Conflicts with main")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("button", { name: "Merge", exact: true })).toBeDisabled();
    });

    await test.step("the monorepo's Activity tab takes a push live", async () => {
      await page.goto(`${BASE}/${full}/activity`);
      await expect(page.getByTestId("activity")).toBeVisible();
      const m = machine();

      m.push(m.commit("web", url, "later", { "src/b.ts": "export const b = 1;\n" }, "Later"), url, "later");
      await expect(page.getByTestId("activity").getByRole("link", { name: "later" }).first()).toBeVisible({ timeout: 30_000 });
    });

    expect(errors).toEqual([]);
  } finally {
    await made.machine?.api("DELETE", `/v1/monorepos/${full}?confirm=${full}`);
  }
});
