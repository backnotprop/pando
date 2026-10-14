// Risk-based review, end to end in a browser (docs/risk-review/DESIGN.md):
// the risk meter on a branch's page and its badge in the branch list, the
// Merge box held for a person, the Guided review panel opening Plannotator's
// guide in the Artifacts tab, Approve, and the Settings switch. Real Worker
// and pando-agents in one wrangler dev (the reviewer agents run in containers
// on the scripted model), real Workers AI writing the guide; the score comes
// from the Worker's test switch (/v1/_risk/test, RISK_TEST=1 in
// worker/.dev.vars with RISK_REVIEW=on), so the tiers are known. Real clef
// is tested by agents/test/risk-review.mjs.
//   PANDO_E2E_WORKER_PORT=8919 PANDO_E2E_STANDIN_PORT=8920 PANDO_E2E_INSPECTOR_PORT=9419 npx playwright test -c playwright.agents.config.ts agents-risk
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { BASE, browserPost, Machine, nextSignIn } from "./seed";

const id = Date.now().toString(36);

const ann = { id: `user_ann_${id}`, email: `ann-${id}@pando.invalid`, email_verified: true, first_name: "Ann", last_name: "Lane" };

const BOOT = /^PANDO_BOOTSTRAP=(.*)$/m.exec(readFileSync(new URL("../../worker/.dev.vars", import.meta.url), "utf8"))?.[1] ?? "";

/** The Worker's risk test switch for one monorepo: the next score, and what the reviewer agents run. */
async function risk(monorepo: string, body: Record<string, string | number | null>) {
  const r = await fetch(`${BASE}/v1/_risk/test`, { method: "POST", headers: { authorization: `Bearer ${BOOT}`, "content-type": "application/json" }, body: JSON.stringify({ monorepo, ...body }) });

  expect(r.status).toBe(200);
}

async function signIn(page: Page) {
  await nextSignIn(ann);
  await page.goto(`${BASE}/login`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
}

test("risk-based review: the meter, the held merge, the guided review, Approve, Settings", async ({ page }) => {
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|404|409|412)/.test(m.text())) errors.push(m.text());
  });

  await signIn(page);
  const made = await browserPost(page, "/v1/monorepos", { name: `risk-${id}`, kind: "repo" });
  const full: string = made.monorepo.full_name;
  const mid: string = made.monorepo.id;
  const url: string = made.repos[0].clone_url;
  const mbp = await Machine.make(page, "ann-mbp", "Ann Lane");
  const dir = mbp.commit("r", url, "main", { "README.md": "# Shop\n", "payments/charge.ts": "export const charge = (cents: number) => ({ cents });\n" }, "first");

  mbp.push(dir, url, "main");

  try {
    // A low score: the meter says so; the branch merges on green checks.
    await risk(mid, { score: 0.1 });
    mbp.commit("r", url, "docs-1", { "README.md": "# Shop\n\nRun it with npm start.\n" }, "docs: how to run");
    mbp.push(dir, url, "docs-1");
    await page.goto(`${BASE}/${full}/branches/docs-1`);
    await expect(page.getByLabel("Risk: Low, auto")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Ready to merge")).toBeVisible();

    // A sensitive change with a high score: human review required, reviewer agents, a guided review.
    await risk(mid, { score: 0.85, model: "scripted", script: '> post_review {"verdict":"comment","body":"Nothing wrong here."}' });
    mbp.commit("r", url, "pay-1", { "payments/charge.ts": "export const charge = (cents: number) => {\n  if (cents <= 0) throw new Error('nothing to charge');\n  return { cents };\n};\n" }, "payments: refuse empty charges");
    mbp.push(dir, url, "pay-1");
    await page.goto(`${BASE}/${full}/branches`);
    const row = page.getByRole("list", { name: "Open branches" }).getByRole("link").filter({ hasText: "pay-1" });

    await expect(row.getByText("High", { exact: true })).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(page.getByLabel("Risk: High, human review required")).toBeVisible();
    await expect(page.getByText("Human review required", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Risk review")).toContainText("A person's approval is needed on this head.");

    // The guide, written by Workers AI from the diff, opens in the Artifacts tab.
    const guide = page.getByLabel("Guided review");

    await expect(guide).toBeVisible();
    await expect(guide.getByRole("link", { name: "Open the guided review" })).toBeVisible({ timeout: 240_000 });
    await expect(page.getByLabel("Risk review")).toContainText("Security", { timeout: 240_000 });
    await guide.getByRole("link", { name: "Open the guided review" }).click();
    await expect(page).toHaveURL(/tab=artifacts.*artifact=guided-review\.html/);
    await expect(page.locator("iframe").first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: "e2e/.state/risk-guide.png" });
    await page.goBack();
    await page.screenshot({ path: "e2e/.state/risk-human.png" });

    // A person approves; the merge is ready.
    await page.getByLabel("Risk review").getByRole("button", { name: "Approve" }).click();
    await expect(page.getByLabel(`Risk: High, approved by ann-${id}`)).toBeVisible();
    await expect(page.getByText("Ready to merge")).toBeVisible();

    // Settings: the project's switch, off then on.
    await page.goto(`${BASE}/${full}/settings`);
    const section = page.getByRole("list", { name: "Risk-based review" });

    await expect(section).toContainText("Merges on green checks below");
    await page.screenshot({ path: "e2e/.state/risk-settings.png", fullPage: true });
    await section.getByRole("switch", { name: /^Risk-based review for/ }).click();
    await expect(section).toContainText("Off");
    await page.goto(`${BASE}/${full}/branches/pay-1`);
    await expect(page.locator("[data-risk]")).toHaveCount(0);
    await page.goto(`${BASE}/${full}/settings`);
    await page.getByRole("list", { name: "Risk-based review" }).getByRole("switch", { name: /^Risk-based review for/ }).click();
    await expect(page.getByRole("list", { name: "Risk-based review" })).toContainText("Merges on green checks below");
    expect(errors).toEqual([]);
  } finally {
    await risk(mid, { score: null, model: null, script: null }).catch(() => undefined);
    await page.request.delete(`/v1/monorepos/${full}?confirm=${full}`);
  }
});
