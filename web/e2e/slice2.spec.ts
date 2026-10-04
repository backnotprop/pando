// Slice 2, end to end: a project's code on main and on a branch (the picker,
// the ahead line, a file, its history), code in colour within the code view's
// size limits, a branch's Files changed taking a push live, its branches, a
// branch's page with its commits and co-authors, checks that Buildkite reports arriving live, a merge
// through the page, a branch left conflicting by that merge, and the
// monorepo's Activity tab taking a push live. Real Worker, real git.
import { expect, type Locator, test } from "@playwright/test";
import { BASE, browserPost, ciStatus, Machine, nextSignIn } from "./seed";

const id = Date.now().toString(36);

const login = `br-${id}`;

const name = `e2e-${id}`;

const full = `${login}/${name}`;

const person = { id: `user_br_${id}`, email: `${login}@pando.invalid`, email_verified: true, first_name: "Branch", last_name: "Lane" };

const project = `${BASE}/${full}/projects/web`;

const COLOUR = `export const colour = "sage";

export function shade(name: string): number {
  return name.length * 2;
}
`;

// 2.2 MiB, over the 1 MiB that is coloured: shown as plain text.
const BIG = Array.from({ length: 80_000 }, (_, i) => `export const n${i} = ${i};\n`).join("");

// A file long enough that Files changed scrolls.
const FILES = Array.from({ length: 150 }, (_, i) => `export const file${i} = ${i};\n`).join("");

// A 1 by 1 PNG, and another (a sage pixel) for a branch to change it to.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const PNG2 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOYc3TLfwAHKwMV6vokJQAAAABJRU5ErkJggg==", "base64");

/** Where a coloured view's line numbers end and its code starts, from the view's left edge. */
const columns = (view: Locator) =>
  view.evaluate((host) => {
    const root = host.shadowRoot;
    const number = root?.querySelector("[data-line-number-content]");
    const line = root?.querySelector("[data-line]");

    if (!number || !line) return null;
    const range = document.createRange();
    const left = host.getBoundingClientRect().left;

    range.selectNodeContents(number);

    return [range.getBoundingClientRect().right - left, line.getBoundingClientRect().left - left];
  });

/** The distance between the first three rows' tops. */
/** The face an element is set in: the first family of its computed stack. */
const face = (el: Locator) => el.evaluate((e) => getComputedStyle(e).fontFamily.split(",")[0]?.replaceAll('"', "").trim());

const pitch = (rows: Locator) => rows.evaluateAll((els) => els.slice(0, 3).map((e) => e.getBoundingClientRect().top)).then(([a = 0, b = 0, c = 0]) => [b - a, c - b]);

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

      const start = {
        "README.md": "# web\n\nThe web project.\n",
        "src/a.ts": "export const a = 1;\n",
        "src/colour.ts": COLOUR,
        "src/big.ts": BIG,
        "logo.png": PNG,
        "docs/GUIDE.md": "# Guide\n\nHow to read [the README](../README.md).\n\n```ts\nexport const answer = 42;\n```\n",
      };

      m.push(m.commit("web", url, "main", start, "Start the web project"), url, "main");
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
      await expect(page.locator(".pn-doc article").getByText("The web project.")).toBeVisible();
      await expect(page.getByRole("link", { name: "2 open branches" })).toBeVisible();
    });

    await test.step("a Markdown file in the project: its Preview through the viewer, its source lines at ?plain=1", async () => {
      await page.goto(`${project}/blob/docs/GUIDE.md`);
      await expect(page.locator(".pn-doc article").getByRole("heading", { name: "Guide" })).toBeVisible();
      // Its code fence takes the code view's palette (theme.css, --diffs-token-*), not a stock Shiki theme.
      await expect(page.locator(".pn-doc pre code span[style*='--diffs-token-']").first()).toBeVisible();
      await page.goto(`${project}/blob/docs/GUIDE.md?plain=1`);
      await expect(page.getByRole("group", { name: "View" }).getByRole("link", { name: "Code" })).toHaveAttribute("aria-current", "page");
      await expect(page.getByText("# Guide")).toBeVisible();
      await expect(page.locator(".pn-doc")).toHaveCount(0);
      // A relative link in the Preview opens that file's page in the project.
      await page.getByRole("group", { name: "View" }).getByRole("link", { name: "Preview" }).click();
      await page.locator(".pn-doc").getByRole("link", { name: "the README" }).click();
      await expect(page).toHaveURL(`${project}/blob/README.md`);
      await page.goto(project);
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

    await test.step("code in colour at the plain lines' pitch; over 1 MiB plain with its note; an image as an image", async () => {
      await page.goto(`${project}/blob/src/colour.ts`);
      // Tokens carry the theme's variables (theme.css), so they take its colours.
      const keyword = page.locator('[data-line] span[style*="--diffs-token-keyword"]').first();

      await expect(keyword).toHaveText("export");

      const [ink, themed] = await keyword.evaluate((el) => {
        const probe = document.body.appendChild(document.createElement("i"));
        probe.style.color = "var(--diffs-token-keyword)";
        const both = [getComputedStyle(el).color, getComputedStyle(probe).color];
        probe.remove();

        return both;
      });

      expect(ink).toBe(themed);
      await expect(page.locator('[data-line] span[style*="--diffs-token-string"]').first()).toHaveText(/sage/);
      expect(await pitch(page.locator("[data-line]"))).toEqual([20, 20]);
      await page.goto(`${project}/blob/src/big.ts`);
      await expect(page.getByText("Over 1 MiB: shown without colour.")).toBeVisible();
      await expect(page.getByText("export const n79999 = 79999;")).toBeAttached();
      await expect(page.locator("diffs-container")).toHaveCount(0);
      expect(await pitch(page.locator("pre > span"))).toEqual([20, 20]);
      await page.goto(`${project}/blob/logo.png`);
      const image = page.getByRole("img", { name: "logo.png" });

      await expect(image).toBeVisible();
      expect(await image.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
    });

    await test.step("Files changed: an edit, an add, a delete and a binary, each with its status; a push shows at once", async () => {
      const m = machine();
      const dir = m.commit("web", url, "files", { "src/colour.ts": COLOUR.replace("sage", "moss"), "src/files.ts": FILES, "logo.png": PNG2 }, "Files changed");

      m.git(dir, "rm", "-q", "README.md");
      m.git(dir, "-c", "user.name=Web Lane", "-c", `user.email=${m.name}@pando.invalid`, "commit", "-qm", "No README");
      m.push(dir, url, "files");
      await page.goto(`${project}/branches/files`);
      await page.getByRole("navigation", { name: "Branch" }).getByRole("link", { name: /Files changed/ }).click();
      await expect(page).toHaveURL(`${project}/branches/files?tab=files`);
      const files = page.getByRole("list", { name: "Files changed" });
      const file = (path: string) => files.getByRole("listitem").filter({ hasText: path });

      await expect(file("src/colour.ts")).toContainText("modified");
      await expect(file("src/colour.ts").locator("[data-line]").filter({ hasText: "moss" })).toBeVisible();
      await expect(file("src/files.ts")).toContainText("added");
      await expect(file("README.md")).toContainText("deleted");
      await expect(file("logo.png")).toContainText("modified");
      await expect(file("logo.png")).toContainText("Binary file");
      await expect(page.getByRole("link", { name: "Files changed 4" })).toBeVisible();
      // Plannotator's tree beside the files: scrolling the files moves it, choosing in it scrolls to the file.
      const tree = page.getByRole("tree", { name: "Changed files" });
      const node = (name: RegExp) => tree.getByRole("treeitem", { name });

      await expect(node(/colour\.ts/)).toHaveAttribute("aria-selected", "true");
      const reach = await file("src/files.ts").evaluate((el) => el.getBoundingClientRect().top - 20);

      await page.mouse.move(900, 500);
      await page.mouse.wheel(0, reach);
      await expect(node(/files\.ts/)).toHaveAttribute("aria-selected", "true");
      await node(/logo\.png/).click();
      await expect(file("logo.png")).toHaveAttribute("aria-current", "true");
      await expect(file("logo.png")).toBeInViewport();
      await expect(node(/logo\.png/)).toHaveAttribute("aria-selected", "true");
      // On a phone the diff scrolls inside its box, never the page, and its numbers and code sit where the code view's do.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      const diffColumns = await columns(file("src/colour.ts").locator("diffs-container"));

      await page.goto(`${project}/blob/src/colour.ts?ref=files`);
      await expect(page.locator("[data-line] span[style]").first()).toBeVisible();
      expect(await columns(page.locator("diffs-container"))).toEqual(diffColumns);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${project}/branches/files?tab=files`);
      await expect(file("src/files.ts")).toContainText("added");
      const live = m.commit("web", url, "files", { "src/live.ts": "export const live = true;\n" }, "Live");

      m.push(live, url, "files");
      await expect(file("src/live.ts")).toContainText("added", { timeout: 30_000 });
      await expect(page.getByRole("link", { name: "Files changed 5" })).toBeVisible();
      // A file with no diff links to its page, at the branch's head.
      await file("logo.png").getByRole("link", { name: "View file" }).click();
      await expect(page).toHaveURL(`${project}/blob/logo.png?ref=${m.git(live, "rev-parse", "HEAD").trim()}`);
      await expect.poll(() => page.getByRole("img", { name: "logo.png" }).evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
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

      // Mono only for code, commit ids and branch names (owner ruling, variant C): a time is SF Pro Text, with tabular figures.
      const commit = page.getByRole("list", { name: "Commits" }).getByRole("listitem").first();
      const time = commit.getByText(/^(now|\d+ (s|min|h|d|w))$/);
      const mono = /^(SF Mono|Ioskeley Mono)$/;

      expect(await face(commit.getByText(/^[0-9a-f]{7}$/))).toMatch(mono);
      expect(await face(page.locator("main p code", { hasText: /^feature$/ }))).toMatch(mono);
      expect(await face(time)).toBe("SF Pro Text");
      expect(await time.evaluate((e) => getComputedStyle(e).fontVariantNumeric)).toBe("tabular-nums");
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
      // The conflicting file shows before anyone presses Merge.
      await expect(page.getByText("src/a.ts", { exact: true })).toBeVisible();
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
