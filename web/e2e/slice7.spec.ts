// Slice 7, end to end: profiles. Pia's repository arrives with a year of
// history, which fills her graph; her profile shows the total the API counts;
// a day's square tells its count and split on hover and from the keyboard,
// and a click shows that day's activity. She edits her profile (the bio stops
// at 160 characters). Her own merge lands while her profile is open: the
// count steps up and today's square glows, with no reload. Bo, who shares one
// repository with her, sees only her work there. At phone width the page
// does not scroll sideways; the graph draws only the whole weeks that fit its
// frame, to today, with no square or month name cut.
// Real Worker, real D1 and Artifacts, real git, real browser.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { BASE, browserPost, HARD_LOAD, Machine, nextSignIn } from "./seed";
import { dayIn, history, noonAgo, onDay, pushMain, year } from "./profile-seed";

const id = Date.now().toString(36);

const pia = { id: `user_pia_${id}`, email: `pia-${id}@pando.invalid`, email_verified: true, first_name: "Pia", last_name: "Lane" };

const bo = { id: `user_bo_${id}`, email: `bo-${id}@pando.invalid`, email_verified: true, first_name: "Bo", last_name: "Lane" };

const login = `pia-${id}`;

const boLogin = `bo-${id}`;

const author = { name: "Pia Lane", email: pia.email };

async function signIn(page: Page, person: typeof pia) {
  await nextSignIn(person);
  await page.goto(`${BASE}/login`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
}

/** A plain repository made as the signed-in person: its full name and clone URL. */
async function repo(page: Page, name: string): Promise<{ full: string; url: string }> {
  const made = await browserPost(page, "/v1/monorepos", { name, kind: "repo" });

  return { full: made.monorepo.full_name, url: made.repos[0].clone_url };
}

/** The contributions the page's person reads for `who`, in the browser's zone. */
async function contributions(page: Page, who: string, tz: number) {
  return (await page.request.get(`/v1/users/${who}/contributions?tz=${tz}`)).json();
}

/** "Saturday, October 3", as the graph says it. */
const longDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

test("slice 7: a profile's graph, its days, Edit profile, a live square, another viewer, a phone", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|404|409)/.test(m.text())) errors.push(m.text());
  });

  const boContext = await browser.newContext();
  const boPage = await boContext.newPage();
  const made: string[] = [];

  try {
    await signIn(boPage, bo);
    await signIn(page, pia);
    const tz = await page.evaluate(() => -new Date().getTimezoneOffset());
    const machine = await Machine.make(page, "pia-mbp", "Pia Lane");
    // The busy day: 9 commits 20 days ago, more than any day of the pattern.
    const busy = dayIn(noonAgo(20, tz), tz);

    await test.step("a repository arrives with a year of history, and her graph fills", async () => {
      const hist = await repo(page, `hist-${id}`);
      made.push(hist.full);
      const commits = [...year(author, tz).filter((c) => dayIn(c.at, tz) !== busy), ...onDay(20, 9, author, tz)];

      pushMain(machine, history(commits), hist.url);
      await expect.poll(async () => (await contributions(page, login, tz)).kinds?.commit, { timeout: 60_000 }).toBe(commits.length);
    });

    const c = await contributions(page, login, tz);

    await test.step("her profile: the header, her repository, the total, a square for every day", async () => {
      await page.goto(`${BASE}/${login}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pia Lane", HARD_LOAD);
      await expect(page.getByRole("complementary", { name: `About ${login}` }).getByText(login, { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Edit profile" })).toBeVisible();
      await expect(page.getByRole("heading", { name: `${c.total.toLocaleString("en-US")} contributions in the last year` })).toBeVisible();
      const days = (Date.parse(c.to) - Date.parse(c.from)) / 86_400_000 + 1;

      await expect(page.getByRole("gridcell")).toHaveCount(days);
      expect(days).toBeGreaterThanOrEqual(365);
      await expect(page.getByRole("region", { name: "Repositories" }).getByRole("link", { name: `${login}/hist-${id}` })).toBeVisible();
      // The busiest day has the top step; an empty day the first.
      await expect(page.locator(`[data-date="${busy}"]`)).toHaveAttribute("data-step", "4");
      await expect(page.locator(`[data-date="${c.from}"]`)).toHaveAttribute("data-step", /[0-4]/);
    });

    await test.step("hover a day: its count and split", async () => {
      await page.locator(`[data-date="${busy}"]`).hover();
      const tip = page.getByRole("tooltip");

      await expect(tip).toContainText(`9 contributions on ${longDay(busy)}`);
      await expect(tip).toContainText("9 commits");
      await expect(page.locator(`[data-date="${busy}"]`)).toHaveAttribute("aria-label", `9 contributions on ${longDay(busy)}`);
    });

    await test.step("the keyboard: arrows move the popover a day or a week, Enter picks the day", async () => {
      const grid = page.getByRole("grid");

      await page.locator(`[data-date="${busy}"]`).click();
      await expect(page).toHaveURL(new RegExp(`\\?day=${busy}$`));
      await grid.focus();
      await page.keyboard.press("ArrowLeft");
      const weekBefore = dayIn(Date.parse(`${busy}T12:00:00Z`) - 7 * 86_400_000 - tz * 60_000, tz);

      await expect(page.getByRole("tooltip")).toContainText(longDay(weekBefore));
      await page.keyboard.press("ArrowDown");
      const dayAfter = dayIn(Date.parse(`${weekBefore}T12:00:00Z`) + 86_400_000 - tz * 60_000, tz);

      await expect(page.getByRole("tooltip")).toContainText(longDay(dayAfter));
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`\\?day=${dayAfter}$`));
      await expect(page.getByRole("region", { name: "Activity" }).getByRole("heading", { name: longDay(dayAfter) })).toBeVisible();
    });

    await test.step("a click on a day shows that day's activity; Back to the year restores the months", async () => {
      await page.locator(`[data-date="${busy}"]`).click();
      const activity = page.getByRole("region", { name: "Activity" });

      await expect(activity.getByRole("heading", { name: longDay(busy) })).toBeVisible();
      await expect(activity.getByText("Created 9 commits in 1 repository")).toBeVisible();
      await activity.getByRole("button", { name: "Back to the year" }).click();
      await expect(page).toHaveURL(`${BASE}/${login}`);
      await expect(activity.getByRole("heading", { level: 3 }).first()).toHaveText(/^[A-Z][a-z]+ \d{4}$/);
    });

    await test.step("Edit profile: a bio stops at 160 characters; saved, it is on her profile after a reload", async () => {
      await page.getByRole("link", { name: "Edit profile" }).click();
      await expect(page).toHaveURL(`${BASE}/settings/profile`);
      const bio = page.getByRole("textbox", { name: "Bio" });

      await bio.fill("x".repeat(170));
      await expect(bio).toHaveValue("x".repeat(160));
      await expect(page.getByText("160 / 160")).toBeVisible();
      await bio.fill("Plans and code.");
      await page.getByRole("textbox", { name: "Location" }).fill("Lisbon");
      await page.getByRole("textbox", { name: "Link 1" }).fill("https://example.com/pia");
      await page.getByRole("button", { name: "Save profile" }).click();
      await expect(page.getByText("Saved.")).toBeVisible();
      await page.reload();
      await expect(page.getByRole("textbox", { name: "Bio" })).toHaveValue("Plans and code.", HARD_LOAD);
      await page.getByRole("button", { name: login, exact: true }).click();
      await page.getByRole("menuitem", { name: "Your profile" }).click();
      const side = page.getByRole("complementary", { name: `About ${login}` });

      await expect(side.getByText("Plans and code.")).toBeVisible();
      await expect(side.getByText("Lisbon")).toBeVisible();
      await expect(side.getByRole("link", { name: "example.com/pia" })).toHaveAttribute("href", "https://example.com/pia");
    });

    await test.step("her own merge lands while her profile is open: the count steps up and today's square glows", async () => {
      const live = await repo(page, `live-${id}`);
      made.push(live.full);
      const dir = machine.dir("live");

      const commit = (file: string, message: string) => {
        writeFileSync(join(dir, file), `${message}\n`);
        machine.git(dir, "add", "-A");
        machine.git(dir, "-c", "user.name=Pia Lane", "-c", `user.email=${pia.email}`, "commit", "-q", "-m", message);
      };

      machine.git(machine.dir(""), "clone", "-q", live.url, "live");
      commit("README.md", "first");
      machine.git(dir, "push", "-q", "origin", "main");
      await page.goto(`${BASE}/${login}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pia Lane", HARD_LOAD);
      // The first push of main counted its commit; the page shows that total, then the merge adds to it.
      await expect.poll(async () => (await contributions(page, login, tz)).total, { timeout: 20_000 }).toBe(c.total + 2);
      await page.reload();
      const before = (await contributions(page, login, tz)).total;

      await expect(page.getByRole("heading", { name: `${before.toLocaleString("en-US")} contributions in the last year` })).toBeVisible(HARD_LOAD);
      machine.git(dir, "checkout", "-q", "-b", "live");
      commit("live.txt", "live");
      machine.git(dir, "push", "-q", "origin", "live");
      const head = machine.git(dir, "rev-parse", "HEAD").trim();
      const merged = await machine.api("POST", `/v1/monorepos/${live.full}/repos/live-${id}/branches/live/merge?force=1`, { expected_head: head });

      expect(merged.status).toBe(200);
      // A branch opened and a commit: two more, with no reload.
      await expect(page.getByRole("heading", { name: `${(before + 2).toLocaleString("en-US")} contributions in the last year` })).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(`[data-date="${c.to}"].graph-glow`)).toBeVisible();
    });

    await test.step("Bo sees only her work in the repository he can open", async () => {
      const shared = await repo(page, `shared-${id}`);
      made.push(shared.full);
      await page.request.put(`/v1/monorepos/${shared.full}/members/${boLogin}`, { data: { role: "member" }, headers: { origin: BASE } });
      pushMain(machine, history(onDay(3, 3, author, tz)), shared.url);
      await expect.poll(async () => (await contributions(boPage, login, tz)).kinds?.commit, { timeout: 30_000 }).toBe(3);
      await boPage.goto(`${BASE}/${login}`);
      await expect(boPage.getByRole("heading", { level: 1 })).toHaveText("Pia Lane", HARD_LOAD);
      await expect(boPage.getByRole("link", { name: "Edit profile" })).toHaveCount(0);
      await expect(boPage.getByRole("region", { name: "Repositories" }).getByRole("link", { name: `${login}/shared-${id}` })).toBeVisible();
      await expect(boPage.getByText(`hist-${id}`)).toHaveCount(0);
      await expect(boPage.getByText(`live-${id}`)).toHaveCount(0);
      // 3 commits and the repository she made, nothing else.
      await expect(boPage.getByRole("heading", { name: "4 contributions in the last year" })).toBeVisible();
    });

    await test.step("a phone: no sideways scroll; the graph draws only the whole weeks its frame holds, to today", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${BASE}/${login}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pia Lane", HARD_LOAD);
      const widths = await page.evaluate(() => ({ page: document.scrollingElement?.scrollWidth ?? 0, view: window.innerWidth }));

      expect(widths.page).toBeLessThanOrEqual(widths.view);

      const fit = await page.getByRole("grid").evaluate((g) => {
        const frame = g.parentElement!.getBoundingClientRect();
        const cells = [...g.querySelectorAll('[role="gridcell"]')].map((c) => c.getBoundingClientRect());

        // The month names are the grid's text spans in its first row, the first one first.
        const months = [...g.querySelectorAll(":scope > span")].flatMap((s) => {
          const r = s.getBoundingClientRect();

          return r.top < (cells[0]?.top ?? 0) ? [{ text: s.textContent, left: r.left }] : [];
        });

        return {
          frame: { left: frame.left, right: frame.right, width: frame.width },
          grid: g.getBoundingClientRect().width,
          scroll: g.parentElement!.scrollWidth - g.parentElement!.clientWidth,
          cellsLeft: Math.min(...cells.map((c) => c.left)),
          cellsRight: Math.max(...cells.map((c) => c.right)),
          cells: cells.length,
          months,
        };
      });

      expect(fit.grid).toBeLessThanOrEqual(fit.frame.width);
      expect(fit.scroll).toBe(0);
      expect(fit.cellsLeft).toBeGreaterThanOrEqual(fit.frame.left);
      expect(fit.cellsRight).toBeLessThanOrEqual(fit.frame.right);
      // Fewer weeks than the year's, and the squares fill the frame: under one column's width left over.
      expect(fit.cells).toBeLessThan(365);
      expect(fit.frame.right - fit.cellsRight).toBeLessThan(15);
      // The first month name is whole: a month's full short name, inside the frame.
      expect(fit.months[0]?.text).toMatch(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/);
      expect(fit.months[0]!.left).toBeGreaterThanOrEqual(fit.frame.left);
      await expect(page.locator(`[data-date="${c.to}"]`)).toBeInViewport();
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    expect(errors).toEqual([]);
  } finally {
    for (const full of made) await page.request.delete(`/v1/monorepos/${full}?confirm=${full}`, { headers: { origin: BASE } });
    await boContext.close();
  }
});
