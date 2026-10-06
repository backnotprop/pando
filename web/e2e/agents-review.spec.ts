// Agents, piece 3, end to end: Review with agent. Ann pushes a branch with a
// typo; on its page, Review with agent starts a review with the scripted
// model. While it works, the agent shows above the Reviews; when it ends, its
// review is there, as Ann, asking for changes, with no reload. Real Worker and
// pando-agents (a real container), real D1, Artifacts and git, a real browser.
import { expect, type Page, test } from "@playwright/test";
import { BASE, browserPost, Machine, nextSignIn } from "./seed";

const id = Date.now().toString(36);

const ann = { id: `user_ann_${id}`, email: `ann-${id}@pando.invalid`, email_verified: true, first_name: "Ann", last_name: "Lane" };

/** A tool call's arguments as the scripted model reads them. */
type ToolArgs = Record<string, string | readonly { path: string; line: number; body: string }[]>;

/** A line the scripted model reads as one tool call (agents/src/models.ts). */
const tool = (name: string, args: ToolArgs) => `> ${name} ${JSON.stringify(args)}`;

async function signIn(page: Page) {
  await nextSignIn(ann);
  await page.goto(`${BASE}/login`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
}

test("agents, piece 3: Review with agent on a branch, at work, then its review", async ({ page }) => {
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|404|409)/.test(m.text())) errors.push(m.text());
  });

  await signIn(page);
  const made = await browserPost(page, "/v1/monorepos", { name: `agents-r-${id}`, kind: "repo" });
  const full: string = made.monorepo.full_name;
  const url: string = made.repos[0].clone_url;
  const mbp = await Machine.make(page, "ann-mbp", "Ann Lane");
  const dir = mbp.commit("r", url, "main", { "README.md": "# Agents\n" }, "first");

  mbp.push(dir, url, "main");
  mbp.commit("r", url, "feature", { "README.md": "# Agents\n\nThis line has a tpyo.\n" }, "A line");
  mbp.push(dir, url, "feature");

  try {
    await page.goto(`${BASE}/${full}/branches/feature`);
    await expect(page.getByText("No reviews yet.")).toBeVisible();
    await page.getByRole("button", { name: "Review with agent" }).click();
    const dialog = page.getByRole("dialog");

    await expect(dialog).toContainText("never an approval");
    await dialog.getByLabel("Model").selectOption({ label: "Scripted (tests)" });
    await dialog
      .getByRole("textbox")
      .fill(
        [
          "Check the spelling.",
          tool("bash", { command: "sleep 4; tail -1 README.md" }),
          tool("post_review", { verdict: "request_changes", body: "One typo.", comments: [{ path: "README.md", line: 3, body: "tpyo: typo" }] }),
        ].join("\n"),
      );
    await dialog.getByRole("button", { name: "Start" }).click();
    await expect(dialog).toBeHidden();

    // At work, live, then gone; its review read in its place.
    const working = page.getByRole("list", { name: "Review agents" });

    await expect(working).toContainText("Agent #1", { timeout: 60_000 });
    await expect(working).toContainText(`ann-${id} on cloud-1`);
    const reviews = page.getByRole("list", { name: "Reviews" });

    await expect(reviews).toContainText("asked for changes", { timeout: 180_000 });
    await expect(reviews).toContainText(`ann-${id}`);
    await expect(reviews).toContainText("One typo.");
    await expect(working).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/v1/monorepos/${full}?confirm=${full}`);
  }
});
