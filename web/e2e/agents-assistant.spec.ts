// Agents, piece 4, end to end: the repository assistant. Ann has a chat (made
// through the API with the scripted model: the panel has no model choice, and
// its default is a real model). On the repository's page the leaf button opens
// the panel; Chats lists the chat by its first message; choosing it shows the
// conversation: her prompt on its soft background, the agent's steps folded.
// A follow-up from the box runs live. Another member's Agents tab does not
// list it. At phone width the panel fills the screen. Real Worker and
// pando-agents, real D1, Artifacts and git, a real browser.
import { expect, type Page, test } from "@playwright/test";
import { BASE, browserPost, Machine, nextSignIn } from "./seed";

const id = Date.now().toString(36);

const ann = { id: `user_ann_${id}`, email: `ann-${id}@pando.invalid`, email_verified: true, first_name: "Ann", last_name: "Lane" };

/** A line the scripted model reads as one tool call (agents/src/models.ts). */
const tool = (name: string, args: Record<string, string>) => `> ${name} ${JSON.stringify(args)}`;

async function signIn(page: Page) {
  await nextSignIn(ann);
  await page.goto(`${BASE}/login`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
}

test("agents, piece 4: the assistant's button, panel, chats and a live follow-up", async ({ page }) => {
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|404|409)/.test(m.text())) errors.push(m.text());
  });

  await signIn(page);
  const made = await browserPost(page, "/v1/monorepos", { name: `agents-a-${id}`, kind: "repo" });
  const full: string = made.monorepo.full_name;
  const url: string = made.repos[0].clone_url;
  const mbp = await Machine.make(page, "ann-mbp", "Ann Lane");
  const dir = mbp.commit("r", url, "main", { "README.md": "# Agents\n", "src/app.js": "export const answer = 42;\n" }, "first");

  mbp.push(dir, url, "main");
  await browserPost(page, `/v1/monorepos/${full}/assistant`, {
    model: "scripted",
    prompt: ["What does src/app.js export?", tool("list_files", { path: "src" }), tool("read_file", { path: "src/app.js" })].join("\n"),
  });

  try {
    await page.goto(`${BASE}/${full}`);
    await page.getByRole("button", { name: "Assistant" }).click();
    const panel = page.getByRole("complementary", { name: "Assistant" });

    await expect(panel.getByRole("textbox", { name: "Ask about this repository" })).toBeVisible();
    await panel.getByRole("button", { name: "Chats" }).click();
    const chats = page.getByRole("list", { name: "Chats" });

    await expect(chats).toContainText("First message: What does src/app.js export?");
    await expect(chats).toContainText("Answered", { timeout: 120_000 });
    await chats.getByRole("button").first().click();

    // The conversation: her prompt, then the two steps folded to one line.
    const log = panel.getByRole("log", { name: "Conversation" });

    await expect(log.locator("[data-prompt]").first()).toContainText("What does src/app.js export?");
    await expect(log.getByRole("button", { name: /2 steps Listed src, Read src\/app\.js/ })).toBeVisible();
    await log.getByRole("button", { name: /2 steps/ }).click();
    await log.getByRole("button", { name: /Read src\/app\.js/ }).click();
    await expect(log).toContainText("export const answer = 42;");

    // A follow-up from the box, live.
    await panel.getByRole("textbox", { name: "Ask about this repository" }).fill(["And the README?", tool("read_file", { path: "README.md" })].join("\n"));
    await panel.getByRole("button", { name: "Send" }).click();
    await expect(log.locator("[data-prompt]").last()).toContainText("And the README?", { timeout: 60_000 });
    await expect(log.getByRole("button", { name: /Read README\.md/ })).toBeVisible({ timeout: 120_000 });

    // A chat is hers alone: the Agents tab does not list it.
    await page.goto(`${BASE}/${full}/agents`);
    await expect(page.getByText("No agents have run in this repository.")).toBeVisible();

    // A phone: the panel fills the screen, nothing scrolls sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Assistant" }).click();
    const box = await page.getByRole("complementary", { name: "Assistant" }).boundingBox();

    expect(box?.width).toBe(390);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    expect(over).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/v1/monorepos/${full}?confirm=${full}`);
  }
});
