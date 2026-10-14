// Risk-based review, end to end in a browser (docs/risk-review/DESIGN.md):
// the risk meter on a branch's page and its badge in the branch list, the
// Merge box held for a person, the Guided review tab (the guide drawn with
// Pando's own pieces: its sections, their diffs, a section ticked as
// reviewed, in dark and light), Approve and Merge from that tab, and the
// Settings switch. Real Worker
// and pando-agents in one wrangler dev (the reviewer agents run in containers
// on the scripted model, set through the Worker's test switch /v1/_risk/test;
// playwright.config.ts --project=risk starts the server with RISK_REVIEW=on
// and RISK_TEST=1), real Workers AI: clef
// scores the money change and GLM-5.3 Flash writes the guide. The story the
// films capture: a comment fix merges with no review; a money change waits
// for a person, with the guide attached.
//   DOCKER_HOST=unix://$HOME/.colima/cloud-agents/docker.sock PANDO_E2E_PORT=8919 PANDO_E2E_INSPECTOR_PORT=9419 npx playwright test --project=risk
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
  // Two reviewer agents in containers and a guide written by Workers AI (24 to 75 s measured).
  test.setTimeout(600_000);
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
  const dir = mbp.commit("r", url, "main", { "README.md": "# Shop\n", "payments/charge.ts": "// Charges a card.\nexport const charge = (cents: number) => ({ cents });\n" }, "first");

  mbp.push(dir, url, "main");

  try {
    // Low risk is never flagged: a comment fix, even inside payments/, is auto by rule (no model call) and merges.
    mbp.commit("r", url, "comment-on-charge", { "payments/charge.ts": "// Charges a card, in cents (never a fraction of a cent).\nexport const charge = (cents: number) => ({ cents });\n" }, "payments: say charges are in cents");
    mbp.push(dir, url, "comment-on-charge");
    await page.goto(`${BASE}/${full}/branches/comment-on-charge`);
    await expect(page.getByLabel("Risk: comments and docs only, auto")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Comments and docs only")).toBeVisible();
    await expect(page.getByText("Ready to merge")).toBeVisible();
    await page.screenshot({ path: "e2e/.state/risk-comment.png" });
    await page.getByRole("button", { name: "Merge", exact: true }).click();
    await expect(page.getByText("Merged into main")).toBeVisible();

    // A money change: real clef scores it, the sensitive path asks a person; reviewer agents run; a guided review is written.
    await risk(mid, { model: "scripted", script: '> post_review {"verdict":"comment","body":"The empty-charge guard looks right."}' });
    mbp.git(dir, "fetch", "-q", url, "main");
    mbp.git(dir, "checkout", "-q", "-B", "main", "FETCH_HEAD");
    mbp.commit("r", url, "charge-refuse-empty", { "payments/charge.ts": "// Charges a card, in cents (never a fraction of a cent).\nexport const charge = (cents: number) => {\n  if (cents <= 0) throw new Error('nothing to charge');\n  return { cents };\n};\n" }, "payments: refuse empty charges");
    mbp.push(dir, url, "charge-refuse-empty");
    await page.goto(`${BASE}/${full}/branches`);
    const row = page.getByRole("list", { name: "Open branches" }).getByRole("link").filter({ hasText: "charge-refuse-empty" });

    await expect(row.getByText(/^(High|Medium|Low)$/)).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(page.getByLabel(/^Risk: (High|Medium|Low), human review required$/)).toBeVisible();
    await expect(page.getByText("Human review required", { exact: true })).toBeVisible();
    await expect(page.getByText("A person's approval is needed on this head", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Risk review").getByRole("button", { name: "Approve" })).toBeVisible();

    // The guide, written by Workers AI from the diff, is read on the branch's own Guided review tab.
    const panel = page.getByLabel("Guided review");

    await expect(panel).toBeVisible();
    await expect(page.getByLabel("Risk review")).toContainText("Security", { timeout: 240_000 });
    await expect(panel.getByRole("link", { name: "Read the guided review" })).toBeVisible({ timeout: 300_000 });
    await page.screenshot({ path: "e2e/.state/risk-human.png" });
    await panel.getByRole("link", { name: "Read the guided review" }).click();
    await expect(page).toHaveURL(/tab=review/);
    await expect(page.getByRole("navigation", { name: "Branch" }).getByRole("link", { name: "Guided review" })).toHaveAttribute("aria-current", "page");

    // Its title and intent, its sections in order, each file's diff drawn by Files changed's own list (shadow DOM: Pierre's).
    const guide = page.getByRole("article", { name: "Guided review" });
    const sections = guide.locator("section");

    await expect(guide.getByRole("heading", { level: 2 })).toBeVisible({ timeout: 30_000 });
    expect(await sections.count()).toBeGreaterThan(0);
    await expect(guide.locator("[data-file-path='payments/charge.ts']")).toBeVisible({ timeout: 30_000 });
    await expect(guide.getByText("nothing to charge").last()).toBeVisible({ timeout: 30_000 });
    const nav = page.getByRole("navigation", { name: "Sections" });

    await expect(nav).toContainText(`0 of ${await sections.count()} reviewed`);

    // Pando's themes: the same page in dark and in light (the films and the owner's look).
    await page.evaluate(() => window.pandoTheme?.set({ theme: "pando", mode: "dark" }));
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: "e2e/.state/risk-guide-dark.png", fullPage: true });
    await page.evaluate(() => window.pandoTheme?.set({ theme: "pando", mode: "light" }));
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: "e2e/.state/risk-guide-light.png", fullPage: true });

    // A section ticked as reviewed folds and counts.
    const first = sections.first();

    await first.getByRole("checkbox", { name: /^Reviewed: / }).click();
    await expect(first.getByRole("checkbox", { name: /^Reviewed: / })).toHaveAttribute("aria-checked", "true");
    await expect(first.getByRole("button", { expanded: false })).toBeVisible();
    await expect(nav).toContainText(`1 of ${await sections.count()} reviewed`);

    // A person approves on the same tab; the merge goes through from there.
    await page.getByLabel("Risk review").getByRole("button", { name: "Approve" }).click();
    await expect(page.getByLabel(/^Risk: (High|Medium|Low), approved by ann-/)).toBeVisible();
    await expect(page.getByText("Ready to merge")).toBeVisible();
    await page.getByRole("button", { name: "Merge", exact: true }).click();
    await expect(page.getByText("Merged into main")).toBeVisible();

    // Settings: the project's switch, off then on.
    await page.goto(`${BASE}/${full}/settings`);
    const section = page.getByRole("list", { name: "Risk-based review" });

    await expect(section).toContainText("Merges on green checks below");
    await page.screenshot({ path: "e2e/.state/risk-settings.png", fullPage: true });
    await section.getByRole("switch", { name: /^Risk-based review for/ }).click();
    await expect(section).toContainText("Off");
    await page.goto(`${BASE}/${full}/branches/charge-refuse-empty`);
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
