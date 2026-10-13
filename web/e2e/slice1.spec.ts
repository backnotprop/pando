// Slice 1, end to end: sign in, the home lists a monorepo just made, a git
// push arrives in the activity log live, the monorepo's root folder, a folder,
// a file with Raw and History, the theme setting, and sign-out. Real Worker,
// real data; the fonts each kind of build ships, from real builds.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { BASE, browserPost, HARD_LOAD, Machine, nextSignIn, saveRootFiles } from "./seed";

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

const WEB = fileURLToPath(new URL("..", import.meta.url));

/**
 * Where an SF build copies Apple's fonts from, as vite.config.ts finds them:
 * PANDO_FONTS_DIR, else the landing page's folder in the meta layer. A
 * checkout outside the monorepo's layout (a public clone) has neither.
 */
const APPLE_FONTS = process.env.PANDO_FONTS_DIR ?? fileURLToPath(new URL("../../../../../../research/design/pando-2026-10-02/landing/fonts", import.meta.url));

/** The app built into a folder of its own (not the dist the Worker serves), with or without Apple's fonts; its files by path. */
function build(sf: boolean) {
  const out = mkdtempSync(join(tmpdir(), "pando-build-"));

  try {
    const env = { ...process.env, PANDO_SF_FONTS: sf ? "1" : "" };
    execFileSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], { cwd: WEB, env, stdio: "pipe" });
    const files = readdirSync(out, { recursive: true, encoding: "utf8" });
    const text = files.filter((f) => /\.(html|css)$/.test(f)).map((f) => readFileSync(join(out, f), "utf8")).join("\n");

    return { files, text };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** data-theme on <html> the moment the app's module script was put in the page (the init script below records it). */
const themeAtApp = (page: Page) => page.evaluate(() => document.documentElement.dataset.atApp ?? null);

/** The signed-in person's avatar in the name button: its slot, its fill as shown, and the theme's colour for that slot (#rrggbb, as rgb()). */
async function avatarOf(page: Page) {
  return page
    .getByRole("button", { name: login })
    .locator("[data-slot]")
    .evaluate((el) => {
      const slot = el.getAttribute("data-slot") ?? "";
      const hex = getComputedStyle(document.documentElement).getPropertyValue(`--av-${slot}-fill`).trim();
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

      return { slot, fill: getComputedStyle(el).backgroundColor, theme: `rgb(${r}, ${g}, ${b})` };
    });
}

/** Opens the name menu and picks a theme or a mode in it. */
async function pick(page: Page, choice: string) {
  if (!(await page.getByRole("menu").isVisible())) await page.getByRole("button", { name: login }).click();
  await page.getByRole("menuitemradio", { name: choice, exact: true }).click();
}

// An HTML file whose scripts would mark the page if any ran: an inline script, a handler, a body script.
const CARD = `<!doctype html><html><head><style>h1 { color: #2a6; }</style><script>window.__ran = "head";</script></head>
<body onload="window.__ran = 'onload'"><h1>Brand card</h1><p><a href="NOTES.md">The notes</a></p><script>document.body.dataset.ran = "body";</script></body></html>
`;

const HEADLINE = "Everything everywhere all at once";

/** Where the sign-in page's shots go (git-ignored): Pando dark and light, at 1440 and 390, for the owner's look. */
const SHOTS = fileURLToPath(new URL("shots/login/", import.meta.url));

/** How many of the root canvas's pixels carry ink, in a 1-in-16 sample (enough to tell drawn from blank). */
const inked = (page: Page) =>
  page.locator("canvas[data-roots]").evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data ?? new Uint8ClampedArray();
    let n = 0;

    for (let i = 3; i < data.length; i += 64) if ((data[i] ?? 0) > 0) n++;

    return n;
  });

/**
 * The sign-in page in a context of its own (so its theme and motion settings
 * never reach the slice's page): what it says, the roots it grows (or shows
 * still), that 390 px never scrolls sideways, and the shots.
 */
async function signInPage(browser: Browser) {
  for (const motion of ["no-preference", "reduce"] as const) {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: motion, deviceScaleFactor: 2 });
      const page = await context.newPage();
      const errors: string[] = [];

      page.on("pageerror", (e) => errors.push(e.message));
      // The roots' states as they come, from the first one, kept on <html> as data-roots-seen.
      await page.addInitScript(() => {
        new MutationObserver((list) => {
          // Read here, not when the script starts: <html> is not there yet then.
          const html = document.documentElement;

          for (const m of list) {
            if (m.target instanceof HTMLElement && m.target.dataset.roots) html.dataset.rootsSeen = [html.dataset.rootsSeen, m.target.dataset.roots].filter(Boolean).join(",");
          }
        }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-roots"] });
      });
      await page.goto("/login?return_to=/settings/profile");
      await expect(page.getByRole("heading", { level: 1, name: HEADLINE })).toBeVisible(HARD_LOAD);
      await expect(page.getByText("A git platform for monorepos, built on Cloudflare, where many agents work at once.")).toBeVisible();
      // The button keeps where the person was going; the Worker takes it to WorkOS.
      await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/v1/login/browser?return_to=%2Fsettings%2Fprofile");
      await expect(page.getByRole("link", { name: "Docs" })).toHaveAttribute("href", "/docs");
      await expect(page.getByRole("link", { name: "gitpando.com" })).toHaveAttribute("href", "https://gitpando.com");
      const roots = page.locator("canvas[data-roots]");

      if (motion === "reduce") {
        // A still: drawn whole at once, never grown.
        await expect(roots).toHaveAttribute("data-roots", "still");
        await expect(page.locator("html")).toHaveAttribute("data-roots-seen", "still");
      } else {
        await expect(roots).toHaveAttribute("data-roots", "grown");
        await expect(page.locator("html")).toHaveAttribute("data-roots-seen", "growing,grown");
      }

      expect(await inked(page)).toBeGreaterThan(500);
      // Nothing scrolls sideways, and the button sits inside the page.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      const box = await page.getByRole("link", { name: "Sign in" }).boundingBox();

      expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);

      if (motion === "reduce") {
        for (const mode of ["dark", "light"] as const) {
          await page.evaluate((m) => window.pandoTheme?.set({ theme: "pando", mode: m }), mode);
          await expect(page.locator("html")).toHaveAttribute("data-theme", `pando-${mode}`);
          // The roots draw again in the new colours on the next frame.
          await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
          await page.screenshot({ path: `${SHOTS}login-pando-${mode}-${width}.png` });
        }
      }

      expect(errors).toEqual([]);
      await context.close();
    }
  }

  // A return_to off this host is dropped: the button goes home.
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("/login?return_to=//evil.example/x");
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/v1/login/browser?return_to=%2F", HARD_LOAD);
  await context.close();
}

test("slice 1: sign in, home, live activity, code, file, raw, history, sign out", async ({ page, browser }) => {
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
    await test.step("the Worker serves Ioskeley Mono, and Apple's SF Pro Text and SF Mono only if the build asked for them", async () => {
      const html = await (await page.request.get("/")).text();
      const sheet = await (await page.request.get(html.match(/\/assets\/[\w.-]+\.css/)?.[0] ?? "/missing.css")).text();
      const mono = sheet.match(/\/assets\/IoskeleyMono-Regular-[\w-]+\.woff2/)?.[0] ?? "/missing.woff2";
      const sf = process.env.PANDO_SF_FONTS === "1";

      expect(sheet).toContain("font-family:Ioskeley Mono");
      const woff = await page.request.get(mono);

      expect(woff.headers()["content-type"]).toBe("font/woff2");
      // A built file's name carries its hash, so it is cached a year (web/public/_headers); the page itself is always asked again.
      expect(woff.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect((await page.request.get("/")).headers()["cache-control"]).toContain("max-age=0");

      for (const file of ["SF-Pro-Text-Regular.otf", "SF-Pro-Text-Semibold.otf", "SFNSMono.ttf"]) {
        const res = await page.request.get(`/fonts/${file}`);
        const type = res.headers()["content-type"];

        if (sf) {
          expect(type).toMatch(/^font\//);
          // Fonts keep their names across builds: a week.
          expect(res.headers()["cache-control"]).toBe("public, max-age=604800");
        } else {
          expect(type).not.toMatch(/^font\//);
        }
      }
    });

    await test.step("a default build ships no font file of Apple's; an SF build ships SF Pro Text and SF Mono, with SF Mono first in the mono stack", async () => {
      // The SF half needs Apple's files, which a public checkout never has: without them it is left out, and says so.
      if (existsSync(APPLE_FONTS)) {
        const sf = build(true);

        expect(sf.files).toEqual(expect.arrayContaining(["fonts/SF-Pro-Text-Regular.otf", "fonts/SF-Pro-Text-Semibold.otf", "fonts/SFNSMono.ttf"]));
        expect(sf.text).toContain('font-family:"SF Mono";src:url("/fonts/SFNSMono.ttf")');
        expect(sf.text).toContain('--mono-face:"SF Mono","Ioskeley Mono"');
      } else {
        test.info().annotations.push({ type: "skipped", description: `the SF build's half: no Apple fonts at ${APPLE_FONTS} (set PANDO_FONTS_DIR to run it)` });
      }

      const plain = build(false);

      expect(plain.files.filter((f) => f.startsWith("fonts") || /SF-?Pro|SFNS|SF-?Mono/i.test(f))).toEqual([]);
      expect(plain.text).not.toMatch(/SF-Pro-Text|SFNSMono|"SF Mono"|--mono-face:/);
      // The SF build copied Apple's files into public/fonts; the default build cleared them again.
      expect(existsSync(join(WEB, "public/fonts"))).toBe(false);
    });

    await test.step("a signed-out visitor gets the sign-in page", async () => {
      await page.goto("/");
      await expect(page).toHaveURL(`${BASE}/login?return_to=/`, HARD_LOAD);
      await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    });

    await test.step("the sign-in page: its headline, line and button, the roots grown (or still with reduced motion), 390 px with no sideways scroll, and its shots", async () => {
      await expect(page.getByRole("heading", { level: 1, name: HEADLINE })).toBeVisible();
      await signInPage(browser);
    });

    await test.step("sign in through WorkOS (the stand-in) returns to the home", async () => {
      await nextSignIn(person);
      await page.getByRole("link", { name: "Sign in" }).click();
      await expect(page).toHaveURL(`${BASE}/`);
      await expect(page.getByRole("button", { name: login })).toBeVisible();
    });

    await test.step("signed in, the sign-in page sends you on to return_to", async () => {
      await page.goto("/login?return_to=/settings/profile");
      await expect(page).toHaveURL(`${BASE}/settings/profile`, HARD_LOAD);
      await page.goto("/");
      await expect(page.getByRole("button", { name: login })).toBeVisible(HARD_LOAD);
    });

    let cloneUrl = "";
    await test.step("make a monorepo, a project, root files and a first push", async () => {
      await browserPost(page, "/v1/monorepos", { name });
      const repo = await browserPost(page, `/v1/monorepos/${full}/repos`, { path: "projects/web" });
      cloneUrl = repo.clone_url;
      made.machine = await Machine.make(page, `laptop-${id}`);
      await saveRootFiles(page, full, machine().name, {
        "AGENTS.md": AGENTS,
        "decisions/RULINGS.md": RULINGS,
        "backlog/board.md": "# Board\n",
        "research/card.html": CARD,
        "research/NOTES.md": "# Notes\n",
      });
      const dir = machine().commit("web", cloneUrl, "main", { "README.md": "# web\n" }, "Start the web project");
      machine().push(dir, cloneUrl, "main");
    });

    await test.step("the home lists the monorepo just made, and loads nothing of the document viewer", async () => {
      const loaded: string[] = [];
      const record = (r: { url: () => string }) => loaded.push(r.url());

      page.on("request", record);
      await page.goto("/");
      await expect(page.getByRole("link", { name: new RegExp(`${login}/${name}`) }).first()).toBeVisible(HARD_LOAD);
      await page.waitForLoadState("networkidle");
      page.off("request", record);
      expect(loaded.filter((url) => /PlannotatorDoc|bridge-script|katex|mermaid/.test(url))).toEqual([]);
    });

    await test.step("What's new is the docs build's JSON; the docs links go through /docs to the docs site", async () => {
      // The stand-in serves this file as the docs site's whats-new.json (e2e/workos.ts).
      const news = JSON.parse(readFileSync(new URL("whats-new.json", import.meta.url), "utf8"));
      const docs = await page.request.get("/docs", { maxRedirects: 0 });
      expect(docs.status()).toBe(302);
      expect(docs.headers().location).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/docs-site\/$/);
      await expect(page.getByRole("link", { name: news.headline })).toHaveAttribute("href", news.link);
      await expect(page.getByText("What's new · Oct 4", { exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Documentation" })).toHaveAttribute("href", "/docs");
      await expect(page.getByRole("link", { name: "Changelog" })).toHaveAttribute("href", "/docs/changelog/");
      await expect(page.getByRole("link", { name: "Contact" })).toHaveAttribute("href", "/docs/contact/");

      // While the docs site can't be reached, the line is hidden (another tab, so its failed fetch is not this test's console error).
      const away = await page.context().newPage();
      await away.route("**/whats-new.json", (route) => route.abort());
      await away.goto("/");
      await expect(away.getByRole("link", { name: "Documentation" })).toBeVisible(HARD_LOAD);
      await expect(away.getByText("What's new")).toHaveCount(0);
      await away.close();
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

    await test.step("an activity row's repository name opens the repository; the rest of the row opens what it is about", async () => {
      const row = page.getByTestId("activity").getByRole("listitem").filter({ hasText: "feature-live" }).first();

      await row.getByRole("link", { name: full, exact: true }).click();
      await expect(page).toHaveURL(`${BASE}/${full}`);
      await page.goBack();
      // Its time, at the left, is not a link of its own: the row's link under it takes the click.
      await row.click({ position: { x: 24, y: 12 } });
      await expect(page).toHaveURL(`${BASE}/${full}/projects/web/branches/feature-live`);
      await page.goto("/");
    });

    await test.step("open the monorepo: the root folder, Clone, the README", async () => {
      await page.getByRole("link", { name: new RegExp(`${login}/${name}`) }).first().click();
      await expect(page).toHaveURL(`${BASE}/${full}`);
      const files = page.getByRole("list", { name: "Files" });
      await expect(files.getByRole("link", { name: "decisions" })).toBeVisible();
      await expect(files.getByRole("link", { name: "projects" })).toBeVisible();
      await expect(files.getByRole("link", { name: "AGENTS.md" })).toBeVisible();
      // The README (AGENTS.md here) renders through Plannotator's viewer, with no Preview | Code; its name opens its page.
      await expect(page.locator(".pn-doc article").getByRole("heading", { name: "What this place is" })).toBeVisible();
      await expect(page.getByRole("group", { name: "View" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "AGENTS.md" }).getByRole("link")).toHaveAttribute("href", `/${full}/blob/AGENTS.md`);
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
      await expect(page.locator(".pn-doc article").getByRole("heading", { name: "Rulings in force" })).toBeVisible();
      await expect(page.getByText("Saved version")).toBeVisible();
    });

    await test.step("a root Markdown file: Preview by default, Code at ?plain=1 with its source lines", async () => {
      const views = page.getByRole("group", { name: "View" });

      await expect(views.getByRole("link", { name: "Preview" })).toHaveAttribute("aria-current", "page");
      await views.getByRole("link", { name: "Code" }).click();
      await expect(page).toHaveURL(`${BASE}/${full}/blob/decisions/RULINGS.md?plain=1`);
      await expect(views.getByRole("link", { name: "Code" })).toHaveAttribute("aria-current", "page");
      await expect(views.getByRole("link", { name: "Preview" })).not.toHaveAttribute("aria-current", "page");
      await expect(page.getByText("# Rulings in force")).toBeVisible();
      await expect(page.locator(".pn-doc")).toHaveCount(0);
      await views.getByRole("link", { name: "Preview" }).click();
      await expect(page).toHaveURL(`${BASE}/${full}/blob/decisions/RULINGS.md`);
      await expect(page.locator(".pn-doc article").getByRole("heading", { name: "Rulings in force" })).toBeVisible();
    });

    await test.step("the theme setting in the name menu: applied before the app's script, kept across a reload, followed by the viewer and the code colours", async () => {
      // Records data-theme the moment the app's module script is put in the page: public/theme.js must have run by then.
      await page.addInitScript(() => {
        new MutationObserver((records, watch) => {
          const app = records.some((r) => [...r.addedNodes].some((n) => n instanceof HTMLScriptElement && n.type === "module"));

          if (!app) return;
          document.documentElement.dataset.atApp = document.documentElement.getAttribute("data-theme") ?? "none";
          watch.disconnect();
        }).observe(document, { childList: true, subtree: true });
      });
      await page.reload();
      expect(await themeAtApp(page)).toBe("pando-dark");
      // An avatar's slot comes from the name; its colours from the theme (avatars.css).
      const pandoAvatar = await avatarOf(page);
      expect(pandoAvatar.fill).toBe(pandoAvatar.theme);
      await expect(page.locator(".pn-doc article")).toBeVisible();

      await pick(page, "Cloudflare");
      await pick(page, "Light");
      await expect(page.getByRole("menuitemradio", { name: "Cloudflare" })).toHaveAttribute("aria-checked", "true");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "cloudflare-light");
      // Plannotator's viewer follows without a reload (its ThemeProvider marks <html> light).
      await expect(page.locator("html")).toHaveClass(/(^|\s)light(\s|$)/);
      const cloudflareAvatar = await avatarOf(page);
      expect(cloudflareAvatar.slot).toBe(pandoAvatar.slot);
      expect(cloudflareAvatar.fill).toBe(cloudflareAvatar.theme);
      expect(cloudflareAvatar.fill).not.toBe(pandoAvatar.fill);
      await page.keyboard.press("Escape");

      await page.reload();
      expect(await themeAtApp(page)).toBe("cloudflare-light");
      await expect(page.locator("body")).toHaveCSS("background-color", "rgb(252, 252, 252)");
      // Pierre's code colours are the theme's own.
      expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--diffs-token-keyword").trim())).toBe("#4b3bdc");

      // System follows the computer, while the page is open.
      await page.emulateMedia({ colorScheme: "dark" });
      await pick(page, "System");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "cloudflare-dark");
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).toHaveAttribute("data-theme", "cloudflare-light");

      // Black Rainbow is dark only: Mode shows Dark and cannot be picked; the kept mode (System) stays for the others.
      await pick(page, "Black Rainbow");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "black-rainbow");
      await expect(page.getByRole("menuitemradio", { name: "Light", exact: true })).toHaveAttribute("aria-disabled", "true");
      await expect(page.getByRole("menuitemradio", { name: "Dark", exact: true })).toHaveAttribute("aria-checked", "true");
      await expect(page.getByRole("menu").getByText("dark only")).toBeVisible();
      await page.keyboard.press("Escape");
      await page.reload();
      expect(await themeAtApp(page)).toBe("black-rainbow");
      const rainbowAvatar = await avatarOf(page);
      expect(rainbowAvatar.slot).toBe(pandoAvatar.slot);
      expect(rainbowAvatar.fill).toBe(rainbowAvatar.theme);
      expect(new Set([pandoAvatar.fill, cloudflareAvatar.fill, rainbowAvatar.fill]).size).toBe(3);
      await expect(page.locator("body")).toHaveCSS("background-color", "rgb(0, 0, 0)");
      expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--diffs-token-keyword").trim())).toBe("#4379fb");
      expect(await page.evaluate(() => localStorage.getItem("pando-mode"))).toBe("system");

      await pick(page, "Pando");
      await pick(page, "Dark");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "pando-dark");
      await expect(page.locator("html")).not.toHaveClass(/(^|\s)light(\s|$)/);
      await page.keyboard.press("Escape");
      expect(await page.evaluate(() => [localStorage.getItem("pando-theme"), localStorage.getItem("pando-mode")])).toEqual(["pando", "dark"]);
    });

    await test.step("an HTML file renders in the viewer with none of its scripts run, and its relative link opens that file", async () => {
      await page.goto(`/${full}/blob/research/card.html`);
      const card = page.frameLocator(".pn-doc iframe");

      await expect(card.getByRole("heading", { name: "Brand card" })).toBeVisible(HARD_LOAD);
      expect(await card.locator("body").evaluate(() => ["__ran" in window, document.body.dataset.ran ?? null, document.querySelectorAll("script:not([src])").length])).toEqual([false, null, 0]);
      expect(await page.evaluate(() => "__ran" in window)).toBe(false);
      await card.getByRole("link", { name: "The notes" }).click();
      await expect(page).toHaveURL(`${BASE}/${full}/blob/research/NOTES.md`);
      await expect(page.locator(".pn-doc article").getByRole("heading", { name: "Notes" })).toBeVisible();
    });

    await test.step("Raw serves the file's bytes as plain text", async () => {
      await page.goto(`/${full}/blob/decisions/RULINGS.md`);
      const raw = page.getByRole("link", { name: "Raw" });
      await expect(raw).toHaveAttribute("href", `/${full}/raw/decisions/RULINGS.md`, HARD_LOAD);
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
