// Agents, piece 1, end to end: the Agents tab and New agent. Ann signs in,
// makes a repository and pushes main and a branch of her own. The tab is
// empty; New agent on a new branch starts #1, whose row moves from Working to
// Waiting for her with no reload; New agent on her existing branch starts #2
// on it. The bar's counts and its filters follow; at phone width nothing
// scrolls sideways. Real Worker and pando-agents (a real container, the
// scripted model), real D1, Artifacts and git, a real browser.
import { expect, type Page, test } from "@playwright/test";
import { BASE, browserPost, Machine, nextSignIn } from "./seed";

const id = Date.now().toString(36);

const ann = { id: `user_ann_${id}`, email: `ann-${id}@pando.invalid`, email_verified: true, first_name: "Ann", last_name: "Lane" };

const login = `ann-${id}`;

/** A line the scripted model reads as one tool call (agents/src/models.ts). */
const tool = (name: string, args: Record<string, string>) => `> ${name} ${JSON.stringify(args)}`;

async function signIn(page: Page) {
  await nextSignIn(ann);
  await page.goto(`${BASE}/login`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
}

const row = (page: Page, n: number) => page.locator(`li[data-agent="${n}"]`);

test("agents, piece 1: the Agents tab, New agent on a new and an existing branch, live rows, filters, a phone", async ({ page }) => {
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|404|409)/.test(m.text())) errors.push(m.text());
  });

  await signIn(page);
  const made = await browserPost(page, "/v1/monorepos", { name: `agents-${id}`, kind: "repo" });
  const full: string = made.monorepo.full_name;
  const url: string = made.repos[0].clone_url;
  const mbp = await Machine.make(page, "ann-mbp", "Ann Lane");
  const dir = mbp.commit("r", url, "main", { "README.md": "# Agents\n" }, "first");

  mbp.push(dir, url, "main");
  mbp.commit("r", url, "half-done", { "notes.md": "started by Ann\n" }, "Ann's start");
  mbp.push(dir, url, "half-done");

  try {
    // ── The tab, empty ──
    await page.goto(`${BASE}/${full}/agents`);
    await expect(page.getByRole("link", { name: /^Agents/ })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("No agents have run in this repository.")).toBeVisible();

    // ── New agent, a new branch ──
    await page.getByRole("button", { name: "New agent" }).click();
    const dialog = page.getByRole("dialog");

    await expect(dialog.getByRole("button", { name: "New branch" })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByText("made off main as")).toBeVisible();
    await dialog.getByRole("textbox").fill(["Leave a note.", tool("bash", { command: "echo note > note.md && git add note.md && git commit -qm 'A note' && git push -q origin HEAD 2>&1; echo pushed=$?" })].join("\n"));
    await dialog.getByRole("button", { name: "Start" }).click();
    await expect(dialog).toBeHidden();

    const one = row(page, 1);

    await expect(one).toContainText("#1");
    await expect(one).toContainText("Task");
    await expect(one).toContainText("agent/1");
    await expect(one).toContainText(`${login}`);
    await expect(one).toContainText("on cloud-1");
    // Live: Working, then Waiting for Ann, with no reload (the agents topic).
    await expect(one).toContainText(`Waiting for ${login}`, { timeout: 180_000 });

    // ── New agent, her existing branch ──
    await page.getByRole("button", { name: "New agent" }).click();
    await dialog.getByRole("textbox").fill(["Finish it.", tool("bash", { command: "git branch --show-current; cat notes.md" })].join("\n"));
    await dialog.getByRole("button", { name: "Existing branch" }).click();
    await expect(dialog.getByRole("button", { name: "Start" })).toBeDisabled();
    await dialog.getByLabel("Find a branch").fill("half");
    await dialog.getByRole("button", { name: /^half-done/ }).click();
    await dialog.getByRole("button", { name: "Start" }).click();
    await expect(dialog).toBeHidden();

    const two = row(page, 2);

    await expect(two).toContainText("half-done");
    await expect(two).toContainText(`Waiting for ${login}`, { timeout: 180_000 });
    const sessions = await (await page.request.get(`/v1/monorepos/${full}/agents/2/transcript`)).json();
    const out = sessions.messages.filter((m: { role: string }) => m.role === "tool").at(-1)?.parts[0]?.text ?? "";

    expect(out).toContain("half-done\nstarted by Ann");

    // ── The bar's counts and filters ──
    const bar = page.getByRole("navigation", { name: "State" });

    await expect(bar.getByRole("link", { name: /All/ })).toContainText("2");
    await expect(bar.getByRole("link", { name: /Waiting/ })).toContainText("2");
    await bar.getByRole("link", { name: /Working/ }).click();
    await expect(page).toHaveURL(/status=working/);
    await expect(page.getByText("No agents match.")).toBeVisible();
    await bar.getByRole("link", { name: /All/ }).click();
    await expect(row(page, 2)).toBeVisible();

    // ── A phone ──
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(row(page, 1)).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    expect(over).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/v1/monorepos/${full}?confirm=${full}`);
  }
});
