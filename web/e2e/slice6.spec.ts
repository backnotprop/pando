// Slice 6, end to end: a large branch's Files changed (e2e/bigdiff.ts: 1,998
// files and about 160,000 changed lines, one file whose diff is 20,000 lines,
// a 5 MB text file changed, renames, deletions, binaries and a lockfile's
// churn), seeded through the real Worker and Artifacts. The first files show
// within a budget while the rest stream in; scrolling the whole list, at a
// flick's speed, never blocks the page for more than 100 ms (every long task
// is watched); the 20,000-line file renders every line, in colour; choosing
// the last file in the tree shows it; the code view of that 10,000-line file
// draws a window at a time. Real Worker, real git, a real browser.
import { expect, type Page, test } from "@playwright/test";
import { bigBranch, seedBigBranch } from "./bigdiff";
import { BASE, browserPost, HARD_LOAD, Machine, nextSignIn, watchLongTasks } from "./seed";

const id = Date.now().toString(36);

const login = `bd-${id}`;

const name = `e2e-${id}`;

const full = `${login}/${name}`;

const person = { id: `user_bd_${id}`, email: `${login}@pando.invalid`, email_verified: true, first_name: "Big", last_name: "Diff" };

const project = `${BASE}/${full}/projects/big`;

/** The machine that pushed, once there is one (the monorepo is deleted through it at the end). */
interface Made {
  machine: Machine | null;
}

/** From a hard load to the first diff on screen (measured 1.7 to 4.7 s on wrangler dev against the real Artifacts, from a fresh push). */
const FIRST_FILE_MS = 10_000;

/** Scrolls the list to its end at `step` px a frame; answers how many frames it took. */
const scrollAll = (page: Page, step: number) =>
  page.getByRole("region", { name: "Files changed" }).evaluate(async (region, px) => {
    const list = [...region.querySelectorAll("*")].find((e) => getComputedStyle(e).overflowY === "auto") ?? region;
    let frames = 0;

    while (list.scrollTop + list.clientHeight < list.scrollHeight - 2) {
      list.scrollTop += px;
      frames++;
      await new Promise(requestAnimationFrame);
    }

    return frames;
  }, step);

/** A file's row in the tree (rows carry their path). */
const inTree = (page: Page, path: string) => page.getByRole("tree", { name: "Changed files" }).locator(`[role="treeitem"][data-path="${path}"]`);

test("slice 6: a large branch's Files changed: first files at once, a smooth scroll through all of it, a 20,000-line diff whole and in colour", async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|409|412)/.test(m.text())) errors.push(m.text());
  });

  const made: Made = { machine: null };

  try {
    await nextSignIn(person);
    await page.goto("/login");
    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${BASE}/`);
    const big = bigBranch();

    await test.step("a project with a large branch, pushed through the Worker", async () => {
      await browserPost(page, "/v1/monorepos", { name });
      const url = (await browserPost(page, `/v1/monorepos/${full}/repos`, { path: "projects/big" })).clone_url;

      const m = await Machine.make(page, `laptop-${id}`, "big");

      made.machine = m;
      seedBigBranch(m, "big", url, "big-change", big);
    });

    await test.step("the first files show within the budget while the rest stream in", async () => {
      const t = Date.now();

      await page.goto(`${project}/branches/big-change?tab=files`);
      // The first file's header (the first ones are binaries, with no lines to show).
      await expect(page.locator("[data-file-path]").first()).toBeVisible({ timeout: FIRST_FILE_MS });
      expect(Date.now() - t).toBeLessThan(FIRST_FILE_MS);
      await expect(page.getByRole("link", { name: "Files changed 1,998" }).or(page.getByRole("link", { name: "Files changed 1998" }))).toBeVisible(HARD_LOAD);
      // The whole branch has come: the reading note is gone.
      await expect(page.getByText(/^Reading the files changed/)).toHaveCount(0, { timeout: 600_000 });
      await expect(page.getByText("Diffs stop at")).toHaveCount(0);
      await expect(page.getByText(/^The rest could not be read/)).toHaveCount(0);
    });

    await test.step("scrolling the whole list at a flick's speed never blocks the page for more than 100 ms", async () => {
      await page.waitForTimeout(1500);
      const longTasks = await watchLongTasks(page);
      const frames = await scrollAll(page, 1000);

      expect(frames).toBeGreaterThan(100);
      expect((await longTasks()).filter((d) => d > 100)).toEqual([]);
      // At the end, the last file is the one the tree shows.
      await expect(inTree(page, big.last)).toHaveAttribute("aria-selected", "true");
    });

    await test.step("choosing the last file in the tree shows it", async () => {
      await page.getByRole("region", { name: "Files changed" }).evaluate((region) => {
        const list = [...region.querySelectorAll("*")].find((e) => getComputedStyle(e).overflowY === "auto");

        if (list) list.scrollTop = 0;
      });
      await inTree(page, big.last).click();
      await expect(page.locator(`[data-file-path="${big.last}"]`)).toBeInViewport();
    });

    await test.step("the 20,000-line diff renders every line, in colour", async () => {
      await inTree(page, big.hugeDiff).click();
      await expect(page.locator(`[data-file-path="${big.hugeDiff}"]`)).toBeInViewport();
      const huge = page.locator("diffs-container").filter({ has: page.locator(`[data-file-path="${big.hugeDiff}"]`) });
      const last = huge.locator("[data-line]").filter({ hasText: "export const row9999 = 19999;" });

      // The lines of it on screen that have no colour yet.
      const plain = () =>
        huge.evaluate(
          (host) =>
            [...(host.shadowRoot?.querySelectorAll("[data-line]") ?? [])].filter((l) => {
              const r = l.getBoundingClientRect();

              return r.top > 0 && r.bottom < innerHeight && l.textContent?.trim() && !l.querySelector("span[style*='--diffs-token-']");
            }).length,
        );

      // Down through it, a screen at a time, until its last added line shows; every line on the way takes its colour.
      for (let screens = 0; !(await last.isVisible()); screens++) {
        await expect.poll(plain, { timeout: 10_000 }).toBe(0);
        await page.mouse.move(900, 600);
        await page.mouse.wheel(0, 1600);
        await page.waitForTimeout(50);
        expect(screens).toBeLessThan(400);
      }

      await expect.poll(plain, { timeout: 10_000 }).toBe(0);
    });

    await test.step("the code view of the 10,000-line file: drawn a window at a time, coloured to its last line", async () => {
      await page.goto(`${project}/blob/${big.hugeDiff}?ref=big-change`);
      await expect(page.locator("diffs-container [data-line] span[style*='--diffs-token-']").first()).toBeVisible(HARD_LOAD);
      const longTasks = await watchLongTasks(page);

      // The page itself scrolls; only the lines near the window are in it.
      await page.evaluate(async () => {
        while (scrollY + innerHeight < document.documentElement.scrollHeight - 2) {
          scrollBy(0, 1000);
          await new Promise(requestAnimationFrame);
        }
      });
      const last = page.locator("diffs-container [data-line]").filter({ hasText: "export const row9999 = 19999;" });

      await expect(last).toBeVisible();
      await expect(last.locator("span[style*='--diffs-token-']").first()).toBeVisible();
      expect(await page.locator("diffs-container").evaluate((host) => host.shadowRoot?.querySelectorAll("[data-line]").length ?? 0)).toBeLessThan(1000);
      expect((await longTasks()).filter((d) => d > 100)).toEqual([]);
    });

    expect(errors).toEqual([]);
  } finally {
    await made.machine?.api("DELETE", `/v1/monorepos/${full}?confirm=${full}`);
  }
});
