// Shots of the profile for the owner's look, not assertions: the mocks' story
// (research/design/pando-ui-2026-10-03/profile/) made real. ramos owns the org
// plannotator, with ana in it; plannotator/workspaces carries a year of his
// work (some with ana as co-author), ramos/pando the last two weeks, and
// ramos/pando-brand and plannotator/plannotator a little; he opened branches
// and reviewed one of ana's. Into e2e/shots/profile/ (with shots.json, each
// file's caption): the profile at 1440 and 390 (Pando dark and light), the graph with its
// popover in all nine theme modes, a picked day, a live square, Edit profile,
// and the profile as ana sees it.
//
//   PANDO_SF_FONTS=1 PANDO_FONTS_DIR=<fonts> npx playwright test --project=profile-shots
import { type Browser, expect, type Page, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, browserPost, type JsonBody, Machine, nextSignIn } from "./seed";
import { type Author, history, noonAgo, onDay, pushMain, year } from "./profile-seed";

const SHOTS = fileURLToPath(new URL("shots/profile/", import.meta.url));

const person = (login: string, first: string, last: string) => ({ id: `user_${login}_local`, email: `${login}@pando.invalid`, email_verified: true, first_name: first, last_name: last });

const ramos = person("ramos", "Michael", "Ramos");

const ana = person("ana", "Ana", "Lopes");

const R: Author = { name: "Michael Ramos", email: ramos.email };

const A: Author = { name: "Ana Lopes", email: ana.email };

const THEMES = ["pando-dark", "pando-light", "plannotator-dark", "plannotator-light", "iris-dark", "iris-light", "cloudflare-dark", "cloudflare-light", "black-rainbow"];

test.use({ deviceScaleFactor: 2 });

async function signIn(page: Page, who: typeof ramos) {
  await nextSignIn(who);
  await page.goto(`${BASE}/login`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
}

/** A write as the browser session that may answer 409 (made by an earlier run). */
async function send(page: Page, method: "POST" | "PUT" | "PATCH", path: string, data: JsonBody) {
  const res = await page.request.fetch(path, { method, data, headers: { origin: BASE } });

  if (!res.ok() && res.status() !== 409) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
}

/** A monorepo made again from nothing, with one project; its clone URL. A plain repo's own URL. */
async function fresh(page: Page, owner: string, name: string, project: string | null): Promise<string> {
  await page.request.delete(`/v1/monorepos/${owner}/${name}?confirm=${owner}/${name}`, { headers: { origin: BASE } });
  const kind = project ? "monorepo" : "repo";
  const made = await browserPost(page, "/v1/monorepos", owner === "ramos" ? { name, kind } : { name, kind, owner });

  return project ? (await browserPost(page, `/v1/monorepos/${owner}/${name}/repos`, { path: project })).clone_url : made.repos[0].clone_url;
}

/** ana signs in once in her own browser; her machine. */
async function anaMachine(browser: Browser): Promise<{ m: Machine; page: Page }> {
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const page = await context.newPage();

  await signIn(page, ana);

  return { m: await Machine.make(page, "ana-mbp", "Ana Lopes"), page };
}

async function seed(page: Page, browser: Browser, tz: number) {
  const { m: anaMbp, page: anaPage } = await anaMachine(browser);
  const mbp = await Machine.make(page, "ramos-mbp", "Michael Ramos");

  await send(page, "PATCH", "/v1/user", { name: "Michael Ramos", bio: "Building Pando and Plannotator.", links: ["https://plannotator.ai"] });
  await send(page, "POST", "/v1/orgs", { login: "plannotator", name: "Plannotator" });
  await send(page, "PUT", "/v1/orgs/plannotator/members/ana", { role: "member" });
  const ws = await fresh(page, "plannotator", "workspaces", "projects/workspaces");
  const ui = await fresh(page, "plannotator", "plannotator", "projects/ui");
  const pando = await fresh(page, "ramos", "pando", "projects/pando");
  const brand = await fresh(page, "ramos", "pando-brand", null);

  // A year in workspaces, a fifth of it with ana as co-author; ana's own work there too.
  const wsYear = year(R, tz).map((c, i) => (i % 5 === 0 ? { ...c, coauthor: A } : c));

  pushMain(mbp, history([...wsYear, ...year(A, tz, 120).filter((_, i) => i % 3 === 0)]), ws);
  // The last two weeks in pando, busier.
  const recent = Array.from({ length: 14 }, (_, d) => onDay(d, [6, 11, 4, 9, 13, 2, 0, 8, 12, 5, 7, 10, 3, 0][d] ?? 0, R, tz)).flat();

  pushMain(mbp, history(recent), pando);
  pushMain(mbp, history([...onDay(2, 3, R, tz), ...onDay(1, 2, R, tz)]), brand);
  pushMain(mbp, history(Array.from({ length: 40 }, (_, i) => ({ at: noonAgo(30 + i * 7, tz), author: R }))), ui);

  // Branches opened, and a review of ana's.
  for (const b of ["search-index", "sync-retry", "graph-glow"]) {
    mbp.push(mbp.commit("pando", pando, b, { [`${b}.txt`]: `${b}\n` }, `Start ${b}`), pando, b);
  }

  anaMbp.push(anaMbp.commit("workspaces", ws, "ana/share", { "share.ts": "export const share = 1;\n" }, "Share a plan"), ws, "ana/share");
  await send(page, "POST", "/v1/monorepos/plannotator/workspaces/repos/projects-workspaces/branches/ana%2Fshare/reviews", { verdict: "approve" });
  await anaPage.context().close();
}

const settle = async (page: Page) => {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => Promise.all([document.fonts.load('14px "SF Mono"'), document.fonts.load('14px "SF Pro Text"'), document.fonts.load('600 14px "SF Pro Text"')]));
  await page.waitForTimeout(900);
};

async function open(page: Page, route: string, theme: string) {
  await page.goto(`${route}${route.includes("?") ? "&" : "?"}theme=${theme}`);
  await settle(page);
}

/** The Contributions section, with room for its popover above. */
async function graphShot(page: Page, file: string) {
  const box = await page.getByRole("region", { name: "Contributions" }).boundingBox();

  if (!box) throw new Error("no graph");
  await page.screenshot({ path: join(SHOTS, file), clip: { x: box.x - 24, y: box.y - 80, width: box.width + 48, height: box.height + 104 } });
}

test("profiles: shots for the owner's look", async ({ page, browser }) => {
  test.setTimeout(900_000);
  mkdirSync(SHOTS, { recursive: true });
  await signIn(page, ramos);
  const tz = await page.evaluate(() => -new Date().getTimezoneOffset());

  await seed(page, browser, tz);
  // The histories are counted in the background: wait for the four.
  await expect
    .poll(async () => ((await (await page.request.get(`/v1/users/ramos/contributions?tz=${tz}`)).json()).monorepos ?? []).length, { timeout: 180_000 })
    .toBeGreaterThanOrEqual(4);
  await page.waitForTimeout(5_000);
  const c = await (await page.request.get(`/v1/users/ramos/contributions?tz=${tz}`)).json();
  const busiest = [...c.days].sort((a, b) => b.n - a.n)[0].date;
  const shots: { file: string; caption: string }[] = [];
  const note = (file: string, caption: string) => shots.push({ file, caption });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });

    for (const theme of ["pando-dark", "pando-light"]) {
      await open(page, "/ramos", theme);
      await page.screenshot({ path: join(SHOTS, `profile-${theme}-${width}.png`), fullPage: true });
      note(`profile-${theme}-${width}.png`, `ramos's own profile, ${theme}, ${width} wide`);
      await open(page, "/settings/profile", theme);
      await page.screenshot({ path: join(SHOTS, `edit-${theme}-${width}.png`), fullPage: true });
      note(`edit-${theme}-${width}.png`, `Edit profile, ${theme}, ${width} wide`);
    }
  }

  await page.setViewportSize({ width: 1440, height: 900 });

  for (const theme of THEMES) {
    await open(page, "/ramos", theme);
    await page.locator(`[data-date="${busiest}"]`).hover();
    await page.waitForTimeout(300);
    await graphShot(page, `graph-${theme}.png`);
    note(`graph-${theme}.png`, `The graph in ${theme}, the busiest day hovered`);
  }

  await open(page, `/ramos?day=${busiest}`, "pando-dark");
  await page.screenshot({ path: join(SHOTS, "day-pando-dark-1440.png"), fullPage: true });
  note("day-pando-dark-1440.png", "A day picked on the graph: its activity alone, with Back to the year");

  // The profile as ana sees it: only what she can open.
  const anaContext = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } });
  const anaPage = await anaContext.newPage();

  await signIn(anaPage, ana);
  await open(anaPage, "/ramos", "pando-dark");
  await anaPage.screenshot({ path: join(SHOTS, "ana-sees-ramos-pando-dark-1440.png"), fullPage: true });
  note("ana-sees-ramos-pando-dark-1440.png", "ramos's profile as ana sees it: only the repositories she can open, no Edit profile");
  await anaContext.close();

  // A live square: ramos's own merge lands while his profile is open.
  await open(page, "/ramos", "pando-dark");
  const mbp = await Machine.make(page, "ramos-sandbox", "Michael Ramos", "sandbox");
  const pando = (await (await page.request.get("/v1/monorepos/ramos/pando/repos/projects-pando")).json()).clone_url;
  const dir = mbp.commit("pando", pando, "live", { "live.txt": "live\n" }, "Land it live");

  mbp.git(dir, "-c", "user.name=Michael Ramos", "-c", `user.email=${ramos.email}`, "commit", "-q", "--amend", "--no-edit", "--reset-author");
  mbp.push(dir, pando, "live");
  const head = mbp.git(dir, "rev-parse", "HEAD").trim();

  await mbp.api("POST", "/v1/monorepos/ramos/pando/repos/projects-pando/branches/live/merge?force=1", { expected_head: head });
  await expect(page.locator(`[data-date="${c.to}"].graph-glow`)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(400);
  await graphShot(page, "live-pando-dark.png");
  note("live-pando-dark.png", "Your own merge lands while your profile is open: today's square glows once in Foxfire");

  writeFileSync(join(SHOTS, "shots.json"), `${JSON.stringify(shots, null, 2)}\n`);
});
