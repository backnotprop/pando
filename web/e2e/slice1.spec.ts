// Slice 1, end to end: sign in, the home lists a monorepo just made, a git
// push arrives in the activity log live, the monorepo's root folder, a folder,
// a file with Raw and History, and sign-out. Real Worker, real data.
import { expect, test } from "@playwright/test";
import { BASE, browserPost, Machine, nextSignIn, saveRootFiles } from "./seed";

const id = Date.now().toString(36);

const login = `web-${id}`;

const name = `e2e-${id}`;

const full = `${login}/${name}`;

const person = { id: `user_web_${id}`, email: `${login}@pando.invalid`, email_verified: true, first_name: "Web", last_name: "Lane" };

interface Made {
  machine: Machine | null;
}

const AGENTS = "You are in this monorepo.\n\n# What this place is\n\nA test monorepo for the web lane.\n";

const RULINGS = "# Rulings in force\n\n- **One monorepo per project.** Code sits under `projects/`.\n";

test("slice 1: sign in, home, live activity, code, file, raw, history, sign out", async ({ page }) => {
  // Script errors and console errors (a CSP refusal among them) fail the run. A 401 while signed out is expected.
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of 401/.test(m.text())) errors.push(m.text());
  });

  // Set by the step that makes it; read by later steps and the cleanup.
  const made: Made = { machine: null };

  const machine = () => {
    if (!made.machine) throw new Error("no machine credential yet");

    return made.machine;
  };

  try {
    await test.step("the Worker serves Ioskeley Mono, and no font file of Apple's unless the build asked for SF Pro Text", async () => {
      const html = await (await page.request.get("/")).text();
      const sheet = await (await page.request.get(html.match(/\/assets\/[\w.-]+\.css/)?.[0] ?? "/missing.css")).text();
      const mono = sheet.match(/\/assets\/IoskeleyMono-Regular-[\w-]+\.woff2/)?.[0] ?? "/missing.woff2";

      expect(sheet).toContain("font-family:Ioskeley Mono");
      expect((await page.request.get(mono)).headers()["content-type"]).toBe("font/woff2");
      expect(html + sheet).not.toMatch(/SFNSMono|SF Mono/);

      if (process.env.PANDO_SF_FONTS !== "1") {
        expect(html + sheet).not.toMatch(/SF-Pro-Text/);
        expect((await page.request.get("/fonts/SF-Pro-Text-Regular.otf")).headers()["content-type"]).not.toMatch(/^font\//);
      }
    });

    await test.step("a signed-out visitor gets the sign-in page", async () => {
      await page.goto("/");
      await expect(page).toHaveURL(`${BASE}/login?return_to=/`);
      await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    });

    await test.step("sign in through WorkOS (the stand-in) returns to the home", async () => {
      await nextSignIn(person);
      await page.getByRole("link", { name: "Sign in" }).click();
      await expect(page).toHaveURL(`${BASE}/`);
      await expect(page.getByRole("button", { name: login })).toBeVisible();
    });

    let cloneUrl = "";
    await test.step("make a monorepo, a project, root files and a first push", async () => {
      await browserPost(page, "/v1/monorepos", { name });
      const repo = await browserPost(page, `/v1/monorepos/${full}/repos`, { path: "projects/web" });
      cloneUrl = repo.clone_url;
      made.machine = await Machine.make(page, `laptop-${id}`);
      await saveRootFiles(page, full, machine().name, { "AGENTS.md": AGENTS, "decisions/RULINGS.md": RULINGS, "backlog/board.md": "# Board\n" });
      const dir = machine().commit("web", cloneUrl, "main", { "README.md": "# web\n" }, "Start the web project");
      machine().push(dir, cloneUrl, "main");
    });

    await test.step("the home lists the monorepo just made", async () => {
      await page.goto("/");
      await expect(page.getByRole("link", { name: new RegExp(`${login}/${name}`) })).toBeVisible();
    });

    await test.step("a git push shows up in the activity log live, without a reload", async () => {
      await page.evaluate(() => sessionStorage.setItem("still-here", "yes"));
      const before = await page.evaluate(() => performance.getEntriesByType("navigation").length);
      const dir = machine().commit("web", cloneUrl, "feature-live", { "src/live.ts": "export const live = true;\n" }, "Live line");
      machine().push(dir, cloneUrl, "feature-live");
      const log = page.getByTestId("activity");
      await expect(log.getByRole("link", { name: "feature-live" }).first()).toBeVisible({ timeout: 30_000 });
      await expect(log.getByText(`from ${machine().name}`).first()).toBeVisible();
      expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(before);
      // A new person's log fits on one page: it ends, with no "Older" to load.
      await expect(page.getByText("No older activity.")).toBeVisible();
    });

    await test.step("open the monorepo: the root folder, Clone, the README", async () => {
      await page.getByRole("link", { name: new RegExp(`${login}/${name}`) }).first().click();
      await expect(page).toHaveURL(`${BASE}/${full}`);
      const files = page.getByRole("list", { name: "Files" });
      await expect(files.getByRole("link", { name: "decisions" })).toBeVisible();
      await expect(files.getByRole("link", { name: "projects" })).toBeVisible();
      await expect(files.getByRole("link", { name: "AGENTS.md" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "What this place is" })).toBeVisible();
      await page.getByRole("button", { name: "Clone" }).click();
      await expect(page.getByText(`pando clone ${full}`)).toBeVisible();
      await expect(page.getByText(cloneUrl)).toBeVisible();
      await page.keyboard.press("Escape");
    });

    await test.step("open a folder, then a file", async () => {
      await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "decisions" }).click();
      await expect(page).toHaveURL(`${BASE}/${full}/tree/decisions`);
      await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "RULINGS.md" }).click();
      await expect(page).toHaveURL(`${BASE}/${full}/blob/decisions/RULINGS.md`);
      await expect(page.getByRole("heading", { name: "Rulings in force" })).toBeVisible();
      await expect(page.getByText("Saved version")).toBeVisible();
    });

    await test.step("Raw serves the file's bytes as plain text", async () => {
      const raw = page.getByRole("link", { name: "Raw" });
      await expect(raw).toHaveAttribute("href", `/${full}/raw/decisions/RULINGS.md`);
      const res = await page.request.get(`/${full}/raw/decisions/RULINGS.md`);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toMatch(/^text\/plain/);
      expect(await res.text()).toBe(RULINGS);
    });

    await test.step("History lists the file's saves", async () => {
      await page.getByRole("link", { name: "History" }).click();
      await expect(page).toHaveURL(`${BASE}/${full}/history/decisions/RULINGS.md`);
      await expect(page.getByText(/^Saved version \d+$/)).toBeVisible();
      await expect(page.getByText("current")).toBeVisible();
    });

    await test.step("sign out ends the session", async () => {
      await page.getByRole("button", { name: login }).click();
      await page.getByRole("menuitem", { name: "Sign out" }).click();
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
      expect((await page.request.get("/v1/user")).status()).toBe(401);
    });

    expect(errors).toEqual([]);
  } finally {
    await made.machine?.api("DELETE", `/v1/monorepos/${full}?confirm=${full}`);
  }
});
