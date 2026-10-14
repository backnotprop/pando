// Agents, piece 1, end to end: the Agents tab and New agent. Ann signs in,
// makes a repository and pushes main and a branch of her own. The tab is
// empty; New agent needs a branch name she types (a bad one is refused), and
// #1 starts on it, its row moving from Working to Waiting for you with no
// reload; a name that exists offers her existing branch, and #2 works on it. The bar's counts and its filters follow; at phone width nothing
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

/** What session n's last tool call answered (its transcript, read as the person). */
async function lastTool(page: Page, full: string, n: number): Promise<string> {
  const t = await (await page.request.get(`/v1/monorepos/${full}/agents/${n}/transcript`)).json();

  return t.messages.filter((m: { role: string }) => m.role === "tool").at(-1)?.parts[0]?.text ?? "";
}

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

    // ── New agent, a new branch it must be given a name for ──
    await page.getByRole("button", { name: "New agent" }).click();
    const dialog = page.getByRole("dialog");

    await expect(dialog.getByRole("button", { name: "New branch" })).toHaveAttribute("aria-pressed", "true");
    await dialog.getByLabel("Model").selectOption({ label: "Scripted (tests)" });
    await dialog.getByRole("textbox", { name: /what to do/i }).fill(["Leave a note.", tool("bash", { command: "git branch --show-current; echo note > note.md && git add note.md && git commit -qm 'A note' && git push -q origin HEAD 2>&1; echo pushed=$?" })].join("\n"));
    // No name, no start: Pando never invents one.
    await expect(dialog.getByRole("button", { name: "Start" })).toBeDisabled();
    await dialog.getByLabel("New branch name").fill("leave a note");
    await expect(dialog.getByText("Letters, digits and . _ / - only, not main.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Start" })).toBeDisabled();
    await dialog.getByLabel("New branch name").fill("leave-a-note");
    await dialog.getByRole("button", { name: "Start" }).click();
    await expect(dialog).toBeHidden();

    const one = row(page, 1);

    await expect(one).toContainText("Agent #1");
    await expect(one).toContainText("leave-a-note");
    await expect(one).toContainText(login);
    // Live: Working, then waiting for her, with no reload (the agents topic).
    await expect(one).toContainText("Waiting for you", { timeout: 180_000 });
    let out = await lastTool(page, full, 1);

    expect(out).toContain("leave-a-note");
    expect(out).toContain("pushed=0");

    // ── A name that exists: use the existing branch ──
    await page.getByRole("button", { name: "New agent" }).click();
    await dialog.getByLabel("Model").selectOption({ label: "Scripted (tests)" });
    await dialog.getByRole("textbox", { name: /what to do/i }).fill(["Finish it.", tool("bash", { command: "git branch --show-current; cat notes.md" })].join("\n"));
    await dialog.getByLabel("New branch name").fill("half-done");
    await expect(dialog.getByText("already exists.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Start" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Use the existing branch" }).click();
    await expect(dialog.getByRole("button", { name: "Existing branch" })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: /^half-done/ })).toHaveAttribute("aria-pressed", "true");
    await dialog.getByRole("button", { name: "Start" }).click();
    await expect(dialog).toBeHidden();

    const two = row(page, 2);

    await expect(two).toContainText("half-done");
    await expect(two).toContainText("Waiting for you", { timeout: 180_000 });
    out = await lastTool(page, full, 2);
    expect(out).toContain("half-done\nstarted by Ann");

    // ── A session's page: the conversation, live; the box for her; Stop ──
    await row(page, 1).getByRole("link", { name: "Agent #1" }).click();
    await expect(page).toHaveURL(`${BASE}/${full}/agents/1`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("leave-a-note");
    const log = page.getByRole("log", { name: "Conversation" });

    await expect(log.locator("[data-prompt]").first()).toContainText("Leave a note.");
    await log.getByRole("button", { name: /^Ran git branch --show-current/ }).click();
    await expect(log).toContainText("pushed=0");
    await page.getByRole("textbox", { name: "Message the agent" }).fill(["One more line.", tool("bash", { command: "echo second-run" })].join("\n"));
    await page.getByRole("button", { name: "Send" }).click();
    await expect(log.locator("[data-prompt]").last()).toContainText("One more line.", { timeout: 60_000 });
    await expect(log.getByRole("button", { name: /^Ran echo second-run/ })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await expect(page.getByText("Stopped by", { exact: false }).first()).toBeVisible();
    await page.goto(`${BASE}/${full}/agents`);

    // ── The bar's counts and filters ──
    const bar = page.getByRole("navigation", { name: "State" });

    // #1 was stopped, and stays stopped: it counts in All, not in Waiting (only #2 waits for her).
    await expect(row(page, 1)).toContainText("Stopped");
    await expect(bar.getByRole("link", { name: /All/ })).toContainText("2");
    await expect(bar.getByRole("link", { name: /Waiting/ })).toContainText("1");
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
