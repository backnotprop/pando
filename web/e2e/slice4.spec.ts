// Slice 4, end to end: issues. A person opens an issue with a label and a
// project, comments with Preview, labels and assigns it, sees it in Needs you,
// reacts; a sandbox's comment shows its machine; a branch whose commit says
// "Fixes #1" is merged through the branch page and the issue, open in a second
// tab, closes live with its timeline line; it is reopened, closed as not
// planned from the other tab; filters and search keep to the address; the
// list takes another session's issues live; labels in Settings; the phone
// layouts. Real Worker, real git, a real browser.
import { expect, type Page, test } from "@playwright/test";
import { BASE, browserPost, Machine, nextSignIn } from "./seed";

const id = Date.now().toString(36);

const login = `is-${id}`;

const name = `e2e-${id}`;

const full = `${login}/${name}`;

const person = { id: `user_is_${id}`, email: `${login}@pando.invalid`, email_verified: true, first_name: "Issue", last_name: "Lane" };

const issues = `${BASE}/${full}/issues`;

/** An issue made through the API as a machine would (pando issue create). */
async function apiIssue(m: Machine, body: Record<string, string | string[]>): Promise<number> {
  const res = await m.api("POST", `/v1/monorepos/${full}/issues`, body);

  if (!res.ok) throw new Error(`create issue: ${res.status} ${await res.text()}`);

  return (await res.json()).number;
}

/** What the test makes along the way: the sandbox's credential (it deletes the repository at the end) and a second tab. */
interface Made {
  sandbox: Machine | null;
  tab: Page | null;
}

/** No sideways scroll at the page's width. */
const fits = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()?.width);

test("slice 4: issues, from a new issue to its close by merge, live", async ({ page }) => {
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|409|412)/.test(m.text())) errors.push(m.text());
  });

  const made: Made = { sandbox: null, tab: null };

  const machine = () => {
    if (!made.sandbox) throw new Error("no machine credential yet");

    return made.sandbox;
  };

  try {
    await nextSignIn(person);
    await page.goto("/login");
    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${BASE}/`);

    let url = "";

    await test.step("a repository with a project, and a sandbox that acts as the person", async () => {
      await browserPost(page, "/v1/monorepos", { name });
      url = (await browserPost(page, `/v1/monorepos/${full}/repos`, { path: "projects/web" })).clone_url;
      made.sandbox = await Machine.make(page, "sandbox-1", "Issue Lane", "sandbox");
      const m = machine();

      m.push(m.commit("web", url, "main", { "README.md": "# web\n", "src/login.ts": "export const ttl = 15;\n" }, "Start the web project"), url, "main");
    });

    await test.step("an empty list, then New issue with a label and a project", async () => {
      await page.goto(issues);
      await expect(page.getByText("No open issues.")).toBeVisible();
      await page.getByRole("link", { name: "New issue" }).click();
      await expect(page).toHaveURL(`${issues}/new`);
      await page.getByRole("textbox", { name: "Title" }).fill("Login fails after token refresh");
      await page.getByRole("textbox", { name: "Description" }).fill("After the session renews, the next call answers 401.\n\n- [x] Reproduce\n- [ ] Fix the renewal\n");
      await page.getByRole("button", { name: "Labels" }).click();
      await page.getByRole("group", { name: "Labels" }).getByRole("button", { name: /^bug/ }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("region", { name: "Labels" }).getByText("bug")).toBeVisible();
      await page.getByRole("button", { name: "Project" }).click();
      await page.getByRole("group", { name: "Project" }).getByRole("button", { name: "projects/web" }).click();
      await expect(page.getByRole("region", { name: "Project" }).getByText("projects/web")).toBeVisible();
      await page.getByRole("button", { name: "Create issue" }).click();
      await expect(page).toHaveURL(`${issues}/1`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Login fails after token refresh#1");
      await expect(page.getByRole("status", { name: "State" })).toHaveText("Open");
      // The body through Plannotator's viewer, its task list as its own list.
      await expect(page.locator("#issue-body .pn-doc").getByText("the next call answers 401")).toBeVisible();
      await expect(page.locator("#issue-body .pn-doc").getByText("Fix the renewal")).toBeVisible();
    });

    await test.step("the list shows it, and the Issues tab counts it", async () => {
      await page.goto(issues);
      const row = page.getByRole("list", { name: "Issues" }).getByRole("listitem").first();

      await expect(row.getByRole("link", { name: "Login fails after token refresh" })).toBeVisible();
      await expect(row.getByText("bug")).toBeVisible();
      await expect(row).toContainText(`#1 opened just now by ${login}`);
      await expect(row).toContainText("projects/web");
      await expect(row).toContainText("1 of 2 tasks");
      await expect(page.getByRole("link", { name: "Issues 1" })).toBeVisible();
      await expect(page.getByRole("link", { name: "1 Open" })).toBeVisible();
    });

    await test.step("a comment written with Preview; a sandbox's comment shows its machine, live", async () => {
      await page.goto(`${issues}/1`);
      const composer = page.getByRole("textbox", { name: "Comment" });

      await composer.fill("The renewal writes **the cookie** too late. See #1.");
      await page.getByRole("tab", { name: "Preview" }).click();
      await expect(page.locator(".pn-doc strong", { hasText: "the cookie" })).toBeVisible();
      await expect(page.locator(".pn-doc a", { hasText: "#1" })).toHaveAttribute("href", `/${full}/issues/1`);
      await page.getByRole("tab", { name: "Write" }).click();
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      const timeline = page.getByRole("region", { name: "Timeline" });

      await expect(timeline.getByRole("region", { name: `Comment by ${login}` }).first()).toContainText("the cookie");
      await expect(composer).toHaveValue("");
      const res = await machine().api("POST", `/v1/monorepos/${full}/issues/1/comments`, { body: "Setting it before the body fixes it: 20 of 20 renewals kept the session." });

      expect(res.status).toBe(201);
      const theirs = timeline.getByRole("region", { name: `Comment by ${login}` }).filter({ hasText: "20 of 20 renewals" });

      await expect(theirs).toBeVisible();
      await expect(theirs.locator("header")).toContainText(`${login}sandbox-1`);
      await expect(page.getByText("3 comments")).toBeHidden();
      await expect(page.getByText("2 comments")).toBeVisible();
    });

    await test.step("a label and an assignee from the sidebar, each a timeline line", async () => {
      await page.getByRole("button", { name: "Labels" }).click();
      await page.getByRole("group", { name: "Labels" }).getByRole("button", { name: /^enhancement/ }).click();
      await page.keyboard.press("Escape");
      const details = page.getByRole("complementary", { name: "Details" });

      await expect(details.getByRole("region", { name: "Labels" }).getByText("enhancement")).toBeVisible();
      await expect(page.getByRole("region", { name: "Timeline" }).getByText(/added\s*enhancement/)).toBeVisible();
      await details.getByRole("button", { name: "assign yourself" }).click();
      await expect(details.getByRole("region", { name: "Assignees" }).getByText(login)).toBeVisible();
      await expect(page.getByRole("region", { name: "Timeline" }).getByText("self-assigned this")).toBeVisible();
    });

    await test.step("a reaction on the body", async () => {
      const body = page.locator("#issue-body");

      await body.getByRole("button", { name: "Add a reaction" }).click();
      await page.getByRole("button", { name: "Thumbs up" }).click();
      await expect(body.getByRole("button", { name: "Thumbs up 1" })).toHaveAttribute("aria-pressed", "true");
    });

    await test.step("the issue assigned to you is in the home's Needs you", async () => {
      await page.goto("/");
      const needs = page.getByRole("link", { name: /1 issue assigned to you/ });

      await expect(needs).toBeVisible();
      // The row's link lies under it; the newest issue is a link of its own on top (links R), so the text is the row's.
      await expect(page.getByRole("listitem").filter({ has: needs })).toContainText("#1 Login fails after token refresh");
      await needs.click({ position: { x: 12, y: 12 } });
      await expect(page).toHaveURL(/\/issues\?assignee=(@|%40)me$/);
      await expect(page.getByRole("list", { name: "Issues" }).getByRole("link", { name: "Login fails after token refresh" })).toBeVisible();
    });

    await test.step("a branch whose commit says Fixes #1, merged on its page: the issue open in another tab closes live", async () => {
      const m = machine();

      m.push(m.commit("web", url, "fix-login", { "src/login.ts": "export const ttl = 15;\nexport const early = true;\n" }, "Set the cookie before the body (fixes #1)"), url, "fix-login");
      const other = await page.context().newPage();

      made.tab = other;
      await other.goto(`${issues}/1`);
      // The commit's link shows in the Development box within about a second of the push.
      await expect(other.getByRole("region", { name: "Development" }).getByRole("link", { name: "fix-login" })).toBeVisible({ timeout: 30_000 });
      await expect(other.getByRole("region", { name: "Development" })).toContainText("Closes this issue on merge · from a commit");
      await page.goto(`${BASE}/${full}/projects/web/branches/fix-login`);
      const block = page.getByRole("list", { name: "Linked issues" });

      await expect(block).toContainText("#1 Login fails after token refresh");
      await expect(block).toContainText("Open · closes on merge");
      await page.getByRole("button", { name: /^Merge/ }).click();
      await expect(page.getByText("Merged into main")).toBeVisible({ timeout: 30_000 });
      await expect(other.getByRole("status", { name: "State" })).toHaveText("Closed", { timeout: 30_000 });
      await expect(other.getByRole("region", { name: "Timeline" }).getByText(/closed this as completed by merging\s*fix-login\s*into main/)).toBeVisible();
      await expect(block).toContainText("Closed #1", { timeout: 30_000 });
    });

    await test.step("reopened here; closed as not planned with a comment from the other tab, live here", async () => {
      const there = made.tab;

      if (!there) throw new Error("no second tab");
      await page.goto(`${issues}/1`);
      await page.getByRole("button", { name: "Reopen issue" }).click();
      await expect(page.getByRole("status", { name: "State" })).toHaveText("Open");
      await expect(page.getByRole("region", { name: "Timeline" }).getByText("reopened this")).toBeVisible();
      await expect(there.getByRole("status", { name: "State" })).toHaveText("Open", { timeout: 15_000 });
      await there.getByRole("textbox", { name: "Comment" }).fill("Not ours to fix after all.");
      await there.getByRole("button", { name: "Close as" }).click();
      await there.getByRole("menuitem", { name: /Close as not planned/ }).click();
      await expect(page.getByRole("status", { name: "State" })).toHaveText("Closed as not planned", { timeout: 15_000 });
      await expect(page.getByRole("region", { name: "Timeline" }).getByText("Not ours to fix after all.")).toBeVisible();
      await expect(page.getByRole("region", { name: "Timeline" }).getByText("closed this as not planned")).toBeVisible();
      await there.close();
    });

    await test.step("another session's issues reach the open list live, with the counts", async () => {
      await page.goto(issues);
      await expect(page.getByText("No open issues.")).toBeVisible();
      await apiIssue(machine(), { title: "Branch picker: recent branches first", labels: ["enhancement"] });
      const list = page.getByRole("list", { name: "Issues" });

      await expect(list.getByRole("link", { name: "Branch picker: recent branches first" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("link", { name: "1 Open" })).toBeVisible();
      await expect(page.getByRole("link", { name: "1 Closed" })).toBeVisible();
      await apiIssue(machine(), { title: "Plan the load test", body: "Measure throughput at 1,000 agents.", labels: ["question"], project: "projects-web" });
      await expect(list.getByRole("listitem").first()).toContainText("Plan the load test", { timeout: 15_000 });
      await expect(page.getByRole("link", { name: "2 Open" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Issues 2" })).toBeVisible();
    });

    await test.step("filters and search keep to the address and survive a reload", async () => {
      await page.getByRole("button", { name: "Label", exact: true }).click();
      await page.getByRole("group", { name: "Labels" }).getByRole("button", { name: /^question/ }).click();
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(`${issues}?label=question`);
      await expect(page.getByRole("list", { name: "Issues" }).getByRole("listitem")).toHaveCount(1);
      await page.reload();
      await expect(page.getByRole("list", { name: "Issues" }).getByRole("link", { name: "Plan the load test" })).toBeVisible();
      await page.goto(issues);
      await page.getByRole("searchbox", { name: "Search issues" }).fill("throughput");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`${issues}?q=throughput`);
      await expect(page.getByRole("list", { name: "Issues" }).getByRole("listitem")).toHaveCount(1);
      await expect(page.getByRole("list", { name: "Issues" })).toContainText("Plan the load test");
      await page.goto(issues);
      await page.getByRole("link", { name: /Closed$/ }).click();
      await expect(page).toHaveURL(`${issues}?state=closed`);
      await expect(page.getByRole("list", { name: "Issues" })).toContainText(`#1 by ${login}, closed as not planned`);
    });

    await test.step("a label made in Settings is offered on the issue", async () => {
      await page.goto(`${BASE}/${full}/settings`);
      await page.getByRole("button", { name: "New label" }).click();
      const form = page.getByRole("form", { name: "New label" });

      await form.getByRole("textbox", { name: "Name" }).fill("auth");
      await form.getByRole("textbox", { name: "Description" }).fill("Sign-in, sessions and credentials");
      await form.getByRole("radio", { name: "yellow" }).click();
      await form.getByRole("button", { name: "Create label" }).click();
      await expect(page.getByRole("list", { name: "Labels" }).getByText("Sign-in, sessions and credentials")).toBeVisible();
      await page.goto(`${issues}/1`);
      await page.getByRole("button", { name: "Labels" }).click();
      await expect(page.getByRole("group", { name: "Labels" }).getByRole("button", { name: /^auth/ })).toBeVisible();
      await page.keyboard.press("Escape");
    });

    await test.step("the activity log: an opened line and a merge closing #1, whose #1 opens the issue; a person's name opens their page", async () => {
      await page.goto(`${BASE}/${full}/activity`);
      const log = page.getByTestId("activity");

      await expect(log.getByText(/merged\s*fix-login\s*into main, closing #1/).first()).toBeVisible();
      // An issue reference is named with its state (links R: it carries its open or closed mark).
      await expect(log.getByRole("link", { name: /^#2, / }).first()).toBeVisible();
      await log.getByRole("listitem").filter({ hasText: /closing/ }).first().getByRole("link", { name: "#1, closed", exact: true }).click();
      await expect(page).toHaveURL(`${issues}/1`);
      await page.getByRole("region", { name: "Timeline" }).getByRole("link", { name: login, exact: true }).first().click();
      await expect(page).toHaveURL(`${BASE}/${login}`);
    });

    await test.step("on a phone: the line's object is a link at rest, in the Link colour and underlined (no pointer to find it)", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${BASE}/${full}/activity`);
      const branch = page.getByTestId("activity").getByRole("link", { name: "fix-login", exact: true }).first();

      await expect(branch).toBeVisible();

      const looks = await branch.evaluate((el) => {
        const probe = document.createElement("span");

        probe.style.color = "var(--link)";
        document.body.append(probe);
        const link = getComputedStyle(probe).color;

        probe.remove();
        const s = getComputedStyle(el);

        return { color: s.color, link, underline: s.textDecorationLine };
      });

      expect(looks.color).toBe(looks.link);
      expect(looks.underline).toContain("underline");
    });

    await test.step("on a phone: the list and the issue fit; Development comes before the timeline", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(issues);
      await expect(page.getByRole("list", { name: "Issues" })).toBeVisible();
      await fits(page);
      await page.goto(`${issues}/1`);
      await expect(page.getByRole("region", { name: "Timeline" })).toBeVisible();
      await fits(page);
      const dev = await page.getByRole("region", { name: "Development" }).boundingBox();
      const timeline = await page.getByRole("region", { name: "Timeline" }).boundingBox();

      expect(dev && timeline && dev.y < timeline.y).toBe(true);
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await test.step("on a phone: Address with agent under the title, full width; Edit and New issue in the ... menu", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${issues}/2`);
      const address = page.getByRole("button", { name: "Address with agent" });

      await expect(address).toBeVisible();
      await address.click();
      await expect(page.getByRole("dialog")).toContainText("Address with agent #2");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: "More" }).click();
      await expect(page.getByRole("menuitem", { name: "New issue" })).toBeVisible();
      const edit = page.getByRole("menuitem", { name: "Edit" });

      await expect(edit).toBeVisible();
      await edit.click();
      const title = page.getByRole("textbox", { name: "Title" });

      await expect(title).toHaveValue("Branch picker: recent branches first");
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Branch picker: recent branches first");
      await fits(page);
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    expect(errors).toEqual([]);
  } finally {
    await made.sandbox?.api("DELETE", `/v1/monorepos/${full}?confirm=${full}`);
  }
});
