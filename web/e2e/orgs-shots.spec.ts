// Shots of the organization screens for the owner's look, not assertions:
// the mocks' story (research/design/pando-ui-2026-10-03/profile/), made real.
// ramos owns the org plannotator, with ana and ben in it and kai invited;
// plannotator/workspaces (lee added there only) and plannotator/plannotator
// have some activity; ramos/pando-brand waits to be transferred. Each screen
// at 1440 and 390, in Pando dark and light and in Plannotator dark, then the
// org's page and Members in every other theme, into e2e/shots/orgs/.
//
//   PANDO_SF_FONTS=1 PANDO_E2E_FEED_FANOUT_MAX=100 npx playwright test --project=org-shots
import { type Browser, expect, type Page, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BASE, browserPost, Machine, nextSignIn } from "./seed";

const SHOTS = fileURLToPath(new URL("shots/orgs/", import.meta.url));

const person = (login: string, first: string, last: string) => ({ id: `user_${login}_local`, email: `${login}@pando.invalid`, email_verified: true, first_name: first, last_name: last });

const ramos = person("ramos", "Michael", "Ramos");

const ana = person("ana", "Ana", "Lopes");

const ben = person("ben", "Ben", "Okafor");

const lee = person("lee", "Lee", "Park");

const THEMES = ["pando-dark", "pando-light", "plannotator-dark"];

// Twice the pixels, as the mocks' renders.
test.use({ deviceScaleFactor: 2 });

async function signIn(page: Page, who: typeof ramos) {
  await nextSignIn(who);
  await page.goto(`${BASE}/login`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
}

/** A person signs in once in their own browser and makes their machine's credential, `{login}-mbp`. */
async function other(browser: Browser, who: typeof ramos): Promise<Machine> {
  const context = await browser.newContext();
  const page = await context.newPage();

  await signIn(page, who);
  const login = who.email.split("@")[0] ?? "";
  const m = await Machine.make(page, `${login}-mbp`, login);

  await context.close();

  return m;
}

/** A write as the browser session that may answer 409 (it was made by an earlier run). */
async function send(page: Page, method: "POST" | "PUT" | "PATCH", path: string, data: Record<string, string>) {
  const res = await page.request.fetch(path, { method, data, headers: { origin: BASE } });

  if (!res.ok() && res.status() !== 409) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
}

async function fresh(page: Page, owner: string, name: string, kind: "monorepo" | "repo" = "monorepo") {
  await page.request.delete(`/v1/monorepos/${owner}/${name}?confirm=${owner}/${name}`, { headers: { origin: BASE } });
  await browserPost(page, "/v1/monorepos", owner === "ramos" ? { name, kind } : { name, kind, owner });
}

/** One commit on a branch of a project, pushed by `m`. */
function push(m: Machine, repo: string, url: string, branch: string, files: Record<string, string>, title: string) {
  m.push(m.commit(repo, url, branch, files, title), url, branch);
}

async function seed(page: Page, browser: Browser) {
  const anaMbp = await other(browser, ana);
  const benMbp = await other(browser, ben);

  await other(browser, lee);
  const sandbox = await Machine.make(page, "sandbox-1", "ramos", "sandbox");

  await send(page, "POST", "/v1/orgs", { login: "plannotator", name: "Plannotator" });
  await send(page, "PATCH", "/v1/orgs/plannotator", { name: "Plannotator", description: "Plan review for coding agents.", website: "https://plannotator.ai" });
  await send(page, "PUT", "/v1/orgs/plannotator/members/ana", { role: "member" });
  await send(page, "PUT", "/v1/orgs/plannotator/members/ben", { role: "member" });
  await send(page, "POST", "/v1/orgs/plannotator/invites", { email: "kai@example.com", role: "member" });
  await fresh(page, "plannotator", "workspaces");
  await fresh(page, "plannotator", "plannotator");
  await fresh(page, "ramos", "pando-brand", "repo");
  await send(page, "POST", "/v1/monorepos/plannotator/workspaces/invites", { email: lee.email, role: "member" });
  const ws = (await browserPost(page, "/v1/monorepos/plannotator/workspaces/repos", { path: "projects/workspaces" })).clone_url;
  const ui = (await browserPost(page, "/v1/monorepos/plannotator/plannotator/repos", { path: "projects/ui" })).clone_url;

  push(sandbox, "workspaces", ws, "main", { "README.md": "# Workspaces\n" }, "Start workspaces");
  push(sandbox, "ui", ui, "main", { "README.md": "# Plannotator UI\n" }, "Start the UI");
  push(benMbp, "ui", ui, "viewer-print", { "print.css": "@media print {}\n" }, "Print the viewer");
  push(sandbox, "workspaces", ws, "sync-retry", { "sync.ts": "export const retries = 3;\n" }, "Retry sync");
  push(anaMbp, "workspaces", ws, "search-index", { "search.ts": "export const index = [];\n" }, "Index search");
}

const settle = async (page: Page) => {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => Promise.all([document.fonts.load('14px "SF Mono"'), document.fonts.load('14px "SF Pro Text"'), document.fonts.load('600 14px "SF Pro Text"')]));
  await page.waitForTimeout(1200);
};

async function shot(page: Page, name: string, route: string, theme: string, open?: (page: Page) => Promise<void>) {
  const width = page.viewportSize()?.width ?? 1440;

  await page.goto(`${route}${route.includes("?") ? "&" : "?"}theme=${theme}`);
  await settle(page);

  if (open) {
    await open(page);
    await page.waitForTimeout(500);
  }

  await page.screenshot({ path: `${SHOTS}${name}-${theme}-${width}.png`, fullPage: !open });
}

test("orgs: shots for the owner's look", async ({ page, browser }) => {
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  await signIn(page, ramos);
  await seed(page, browser);
  // The summary lines (projects, open branches) tick every 10 s.
  await page.waitForTimeout(11_000);

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });

    for (const theme of THEMES) {
      await shot(page, "org", "/plannotator", theme);
      await shot(page, "org-people", "/orgs/plannotator/people", theme);
      await shot(page, "org-settings", "/orgs/plannotator/settings", theme);
      await shot(page, "org-new", "/orgs/new", theme, async (p) => {
        await p.getByRole("textbox", { name: "Name", exact: true }).fill("acme-labs");
        await p.getByRole("textbox", { name: "Display name" }).fill("Acme Labs");
        await expect(p.getByText("acme-labs is available.")).toBeVisible();
      });
      await shot(page, "members-org", "/plannotator/workspaces/members", theme);
      await shot(page, "transfer", "/ramos/pando-brand/settings", theme);
      await shot(page, "name-menu", "/", theme, (p) => p.getByRole("button", { name: "ramos", exact: true }).click());
      await shot(page, "switcher", "/plannotator/workspaces/members", theme, (p) => p.getByRole("button", { name: /^Switch / }).click());
    }
  }

  // Every other theme, at 1440: the org's page and an org repository's Members.
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const theme of ["plannotator-light", "iris-dark", "iris-light", "cloudflare-dark", "cloudflare-light", "black-rainbow"]) {
    await shot(page, "org", "/plannotator", theme);
    await shot(page, "members-org", "/plannotator/workspaces/members", theme);
  }
});
