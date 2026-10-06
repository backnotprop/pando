// Agents, piece 2, end to end: Address with agent. Ann files an issue on her
// repository; on its page, Address with agent offers the branch named from the
// issue (1-the-readme-has-a-typo). She starts it with the scripted model; the
// issue's Agents block shows Agent #1, the agent comments as her from
// cloud-1, merges, and the issue closes, all with no reload. A closed issue
// offers no Address with agent. Real Worker and pando-agents (a real
// container), real D1, Artifacts and git, a real browser.
import { expect, type Page, test } from "@playwright/test";
import { BASE, browserPost, Machine, nextSignIn } from "./seed";

const id = Date.now().toString(36);

const ann = { id: `user_ann_${id}`, email: `ann-${id}@pando.invalid`, email_verified: true, first_name: "Ann", last_name: "Lane" };

/** A tool call's arguments as the scripted model reads them. */
type ToolArgs = Record<string, string | number | readonly { oldText: string; newText: string }[]>;

/** A line the scripted model reads as one tool call (agents/src/models.ts). */
const tool = (name: string, args: ToolArgs) => `> ${name} ${JSON.stringify(args)}`;

async function signIn(page: Page) {
  await nextSignIn(ann);
  await page.goto(`${BASE}/login`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
}

test("agents, piece 2: Address with agent on an issue, its Agents block, live to closed", async ({ page }) => {
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|404|409)/.test(m.text())) errors.push(m.text());
  });

  await signIn(page);
  const made = await browserPost(page, "/v1/monorepos", { name: `agents-i-${id}`, kind: "repo" });
  const full: string = made.monorepo.full_name;
  const url: string = made.repos[0].clone_url;
  const mbp = await Machine.make(page, "ann-mbp", "Ann Lane");
  const dir = mbp.commit("r", url, "main", { "README.md": "# Agents\n\nA tpyo here.\n" }, "first");

  mbp.push(dir, url, "main");

  const body = [
    "The README says tpyo.",
    "",
    tool("edit", { path: "README.md", edits: [{ oldText: "tpyo", newText: "typo" }] }),
    tool("bash", { command: "git commit -qam 'Fix the README typo' && git push -q origin HEAD 2>&1; echo pushed=$?" }),
    tool("comment_issue", { number: 1, body: "Fixed the typo." }),
    tool("merge", {}),
  ].join("\n");

  await browserPost(page, `/v1/monorepos/${full}/issues`, { title: "The README has a typo", body });

  try {
    await page.goto(`${BASE}/${full}/issues/1`);
    await expect(page.getByRole("region", { name: "Agents" })).toHaveCount(0);
    await page.getByRole("button", { name: "Address with agent" }).click();
    const dialog = page.getByRole("dialog");

    await expect(dialog.getByRole("textbox").first()).toHaveValue("1-the-readme-has-a-typo");
    await dialog.getByLabel("Model").selectOption({ label: "Scripted (tests)" });
    await dialog.getByRole("button", { name: "Start" }).click();
    await expect(dialog).toBeHidden();

    const agents = page.getByRole("region", { name: "Agents" });

    await expect(agents).toContainText("Agent #1");
    await expect(agents).toContainText(`ann-${id} on cloud-1`);
    // Live: the agent's comment as Ann from cloud-1, its merge, and the issue closing, with no reload.
    await expect(page.getByText("Fixed the typo.")).toBeVisible({ timeout: 180_000 });
    await expect(page.getByRole("status", { name: "State" })).toHaveText("Closed", { timeout: 60_000 });
    await expect(page.getByRole("region", { name: "Development" })).toContainText("1-the-readme-has-a-typo");
    await expect(page.getByRole("button", { name: "Address with agent" })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await page.request.delete(`/v1/monorepos/${full}?confirm=${full}`);
  }
});
