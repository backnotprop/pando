// Artifacts, end to end: documents uploaded to a branch's page, with
// comments. A branch with none shows the drop zone and the command; a drop of
// a plan, a banner and the banner's image makes two artifacts (the image goes
// with the page that uses it). On the plan: words selected and commented
// (Plannotator's composer), a reply, a comment a machine posts through the API
// arriving live, a thread resolved (it folds and leaves the document). v2 from
// the CLI's route changes the quoted words: that comment says Unanchored and
// Made on v1, which opens v1, where it places again. On the banner: a
// pinpoint on its button, numbered in the frame. Pando dark and light, 1440
// and 390, with no sideways scroll on a phone. Real Worker, real Durable
// Objects and R2, real git, a real browser.
import { mkdirSync } from "node:fs";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { BASE, browserPost, HARD_LOAD, Machine, nextSignIn } from "./seed";

const id = Date.now().toString(36);

const login = `ar-${id}`;

const name = `art-${id}`;

const full = `${login}/${name}`;

const person = { id: `user_ar_${id}`, email: `${login}@pando.invalid`, email_verified: true, first_name: "Ana", last_name: "Lane" };

const branch = "refresh-margin";

const page_ = `${BASE}/${full}/projects/web/branches/${branch}`;

const QUOTE = "refresh it when 80 percent of its life has passed";

const PLAN_V1 = `# Refresh the sign-in token before it runs out

A WorkOS session token lives 15 minutes. The fix: ${QUOTE}, in one place each side.

## What changes

- The web keeps the token's expiry beside it and sets one timer.
- The refresh runs in the Worker, not the browser, so the cookie never reaches a script.

## Open questions

Whether a refresh that fails mid-merge retries or signs out at once. A second failure signs out.
`;

const PLAN_V2 = PLAN_V1.replace(QUOTE, "refresh it three minutes before it runs out");

const BANNER = `<!doctype html><html><head><title>Sign-in banner</title>
<style>body{font:16px system-ui;margin:24px} .bar{display:flex;gap:12px;align-items:center;padding:16px;border:1px solid #e6c98f;background:#fff7e6}</style>
<script>document.title = "ran";</script></head>
<body><h1>Three minutes before the token runs out</h1>
<div class="bar"><span>Your session ends in 3 minutes.</span><button id="stay">Stay signed in</button><button>Sign out</button></div>
<img src="hero.png" alt="Hero" width="2" height="2"></body></html>`;

// A 2 by 2 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDKgAQYYAADhAQP/PqU5mQAAAABJRU5ErkJggg==", "base64");

/** Files dropped on an element, as a person's drop would bring them (a DataTransfer in the page). */
async function drop(page: Page, target: string, files: { name: string; type: string; body: string | Buffer }[]) {
  const sent = files.map((f) => ({ name: f.name, type: f.type, b64: Buffer.from(f.body).toString("base64") }));

  const dt = await page.evaluateHandle((list) => {
    const t = new DataTransfer();

    for (const f of list) t.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));

    return t;
  }, sent);

  await page.dispatchEvent(target, "dragover", { dataTransfer: dt });
  await page.dispatchEvent(target, "drop", { dataTransfer: dt });
}

/** Selects `words` in the Markdown document (a real mouse drag over their range), as a person does. */
async function select(page: Page, words: string) {
  const box = await page.evaluate((w) => {
    const root = document.querySelector(".pn-doc article") ?? document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.textContent?.indexOf(w) ?? -1;

      if (at < 0) continue;
      const r = document.createRange();

      r.setStart(n, at);
      r.setEnd(n, at + w.length);
      const rects = r.getClientRects();
      const first = rects[0];
      const last = rects[rects.length - 1];

      if (!first || !last) return null;

      return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
    }

    return null;
  }, words);

  if (!box) throw new Error(`"${words}" is not in the document`);
  await page.mouse.move(box.x1, box.y1);
  await page.mouse.down();
  await page.mouse.move(box.x2, box.y2, { steps: 8 });
  await page.mouse.up();
}

/** Uploads a version as the CLI does: multipart with the machine's credential. */
async function cliAdd(m: Machine, file: string, body: string) {
  const form = new FormData();

  form.append("file", new Blob([body], { type: "text/markdown" }), file);
  const res = await m.upload(`/v1/monorepos/${full}/repos/projects-web/branches/${branch}/artifacts`, form);

  if (!res.ok) throw new Error(`artifact add: ${res.status} ${await res.text()}`);

  return res.json();
}

/** No sideways scroll at the page's width. */
const fits = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()?.width);

const panel = (page: Page) => page.getByRole("region", { name: "Comments" });

const card = (page: Page, text: string) => panel(page).locator("[data-annotation-id]").filter({ hasText: text });

/** What the test makes along the way: the sandbox's credential (it deletes the repository at the end). */
interface Made {
  machine: Machine | null;
}

const SHOTS = "e2e/shots/artifacts";

async function shots(page: Page, what: string) {
  mkdirSync(SHOTS, { recursive: true });

  for (const mode of ["dark", "light"] as const) {
    await page.evaluate((m) => window.pandoTheme?.set({ theme: "pando", mode: m }), mode);

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);

      if (width === 390) await fits(page);
      await page.screenshot({ path: `${SHOTS}/${what}-pando-${mode}-${width}.png`, fullPage: true });
    }
  }

  await page.evaluate(() => window.pandoTheme?.set({ theme: "pando", mode: "dark" }));
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("artifacts: drop, comment, reply, live, resolve, v2 and Unanchored, an HTML pinpoint", async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|404|409)/.test(m.text())) errors.push(m.text());
  });

  const made: Made = { machine: null };

  const sandbox = () => {
    if (!made.machine) throw new Error("no machine credential yet");

    return made.machine;
  };

  try {
    await nextSignIn(person);
    await page.goto("/login");
    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${BASE}/`);

    await test.step("a repository with a project and a branch, and a sandbox that acts as the person", async () => {
      await browserPost(page, "/v1/monorepos", { name });
      const url = (await browserPost(page, `/v1/monorepos/${full}/repos`, { path: "projects/web" })).clone_url;

      made.machine = await Machine.make(page, "sandbox-1", "Ana Lane", "sandbox");
      const m = sandbox();

      m.push(m.commit("web", url, "main", { "README.md": "# web\n" }, "Start the web project"), url, "main");
      m.push(m.commit("web", url, branch, { "src/refresh.ts": "export const margin = 3;\n" }, "Refresh the sign-in token before it runs out"), url, branch);
    });

    await test.step("no artifacts yet: the tab, the drop zone, Add and the command", async () => {
      await page.goto(page_);
      const tab = page.getByRole("navigation", { name: "Branch" }).getByRole("link", { name: "Artifacts" });

      await expect(tab).toBeVisible(HARD_LOAD);
      await tab.click();
      await expect(page).toHaveURL(`${page_}?tab=artifacts`);
      await expect(page.getByText("Drop Markdown, HTML or images")).toBeVisible();
      await expect(page.getByRole("button", { name: "Add" })).toBeVisible();
      await expect(page.getByText(`pando artifact add ${branch} plan.md`)).toBeVisible();
      await shots(page, "empty");
    });

    await test.step("a drop makes two artifacts: the plan, and the banner with the image it uses", async () => {
      await drop(page, "[data-drop-zone]", [
        { name: "refresh-plan.md", type: "text/markdown", body: PLAN_V1 },
        { name: "banner.html", type: "text/html", body: BANNER },
        { name: "hero.png", type: "image/png", body: PNG },
        { name: "token-timeline.png", type: "image/png", body: PNG },
      ]);
      const dialog = page.getByRole("dialog");
      const rows = dialog.getByRole("list", { name: "What will be added" }).getByRole("listitem");

      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText("refresh-plan.md");
      await expect(rows.nth(0)).toContainText("New");
      await expect(rows.nth(1)).toContainText("banner.html");
      await expect(rows.nth(1)).toContainText("with hero.png");
      // No document names it: an image artifact of its own.
      await expect(rows.nth(2)).toContainText("token-timeline.png");
      await shots(page, "add");
      await dialog.getByRole("button", { name: "Add 3 artifacts" }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      const list = page.getByRole("list", { name: "Artifacts" });

      await expect(list.getByRole("listitem")).toHaveCount(3);
      await expect(list).toContainText("Refresh the sign-in token before it runs out");
      await expect(list).toContainText("refresh-plan.md");
      await expect(list.getByRole("listitem").nth(0)).toContainText("No comments");
      await expect(page.getByRole("navigation", { name: "Branch" }).getByRole("link", { name: /Artifacts\s*3/ })).toBeVisible();
      await shots(page, "list");
    });

    await test.step("the plan: words selected and commented, a reply", async () => {
      await page.getByRole("link", { name: "Refresh the sign-in token before it runs out" }).click();
      await expect(page).toHaveURL(`${page_}?tab=artifacts&artifact=refresh-plan.md`);
      await expect(page.locator(".pn-doc").getByRole("heading", { name: "Refresh the sign-in token before it runs out" })).toBeVisible(HARD_LOAD);
      await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("1");
      await select(page, QUOTE);
      await page.locator(".annotation-toolbar").getByRole("button", { name: "Comment" }).click();
      await page.locator("[data-comment-popover] textarea").fill("Why 80? Say it in minutes.");
      await page.locator("[data-comment-popover]").getByRole("button", { name: /^Save|^Add/ }).click();
      await expect(card(page, "Why 80? Say it in minutes.")).toBeVisible();
      await expect(card(page, "Why 80?")).toContainText(QUOTE);
      // Placed: its words are lit in the document.
      await expect(page.locator(".pn-doc article mark, .pn-doc article [data-highlight-id]").filter({ hasText: "80 percent" }).first()).toBeVisible();
      await card(page, "Why 80?").getByRole("button", { name: "Reply" }).click();
      await panel(page).getByRole("textbox", { name: "Reply" }).fill("Agreed. v2 will say three minutes.");
      await panel(page).getByRole("button", { name: "Reply", exact: true }).last().click();
      await expect(panel(page).locator("[data-annotation-reply]").filter({ hasText: "Agreed. v2 will say three minutes." })).toBeVisible();
    });

    let artifactId = "";

    await test.step("a machine's comment through the API arrives live, with its machine", async () => {
      const m = sandbox();
      const list = await (await m.api("GET", `/v1/monorepos/${full}/repos/projects-web/branches/${branch}/artifacts`)).json();

      artifactId = list.artifacts.find((a: { name: string }) => a.name === "refresh-plan.md").id;
      const res = await m.api("POST", `/v1/monorepos/${full}/artifacts/${artifactId}/comments`, { quote: "A second failure signs out", body: "Leave the merge running on the server." });

      expect(res.ok).toBe(true);
      await expect(card(page, "Leave the merge running on the server.")).toBeVisible({ timeout: 15_000 });
      await expect(card(page, "Leave the merge running")).toContainText("sandbox-1");
      await expect(page.locator(".pn-doc article").locator("mark, [data-highlight-id]").filter({ hasText: "A second failure" }).first()).toBeVisible();
      await shots(page, "markdown");
    });

    await test.step("resolve: the thread folds to one line and leaves the document; Resolved shows it", async () => {
      await card(page, "Leave the merge running").getByRole("button", { name: "Resolve" }).click();
      const folded = panel(page).getByRole("list", { name: "Resolved threads" });

      await expect(folded).toContainText(`Resolved by ${login}`);
      await expect(card(page, "Leave the merge running")).toHaveCount(0);
      await expect(page.locator(".pn-doc article").locator("mark, [data-highlight-id]").filter({ hasText: "A second failure" })).toHaveCount(0);
      await panel(page).getByRole("button", { name: /^Resolved 1/ }).click();
      await expect(card(page, "Leave the merge running")).toBeVisible();
      await expect(card(page, "Leave the merge running").getByRole("button", { name: "Reopen" })).toBeVisible();
      await panel(page).getByRole("button", { name: /^Open 1/ }).click();
    });

    await test.step("v2 from the CLI changes the quoted words: Unanchored and Made on v1, which opens v1 where it places", async () => {
      const v2 = await cliAdd(sandbox(), "refresh-plan.md", PLAN_V2);

      expect(v2.latest.n).toBe(2);
      await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("2", { timeout: 15_000 });
      await expect(page.locator(".pn-doc article")).toContainText("refresh it three minutes before it runs out");
      const lost = card(page, "Why 80?");

      await expect(lost.locator("[data-annotation-unanchored]")).toBeVisible();
      await shots(page, "unanchored");
      // At the thread's foot, after its reply.
      await panel(page).getByRole("button", { name: "Made on v1", exact: true }).click();
      await expect(page).toHaveURL(/[?&]v=1/);
      await expect(page.getByRole("combobox", { name: "Version" })).toHaveValue("1");
      await expect(card(page, "Why 80?").locator("[data-annotation-unanchored]")).toHaveCount(0);
      await expect(page.locator(".pn-doc article").locator("mark, [data-highlight-id]").filter({ hasText: "80 percent" }).first()).toBeVisible();
      // Code shows the version's text.
      await page.getByRole("group", { name: "View" }).getByRole("link", { name: "Code" }).click();
      await expect(page.getByText(QUOTE).first()).toBeVisible();
    });

    await test.step("the banner: its own frame, scripts stripped, a pinpoint on its button numbered in the frame", async () => {
      await page.getByRole("link", { name: "Artifacts" }).first().click();
      await page.getByRole("link", { name: "Sign-in banner" }).click();
      const frame: FrameLocator = page.frameLocator(".pn-doc iframe");

      await expect(frame.getByRole("heading", { name: "Three minutes before the token runs out" })).toBeVisible(HARD_LOAD);
      // The page's own script never ran.
      expect(await frame.locator("title").textContent()).toBe("Sign-in banner");
      await frame.getByRole("button", { name: "Stay signed in" }).click();
      await page.locator("[data-comment-popover] textarea").fill("Say how long: for 15 more minutes.");
      await page.locator("[data-comment-popover]").getByRole("button", { name: /^Save|^Add/ }).click();
      await expect(card(page, "Say how long")).toBeVisible();
      await expect(card(page, "Say how long")).toContainText("Stay signed in");
      await expect(frame.locator("[data-plannotator-marker], [data-annotation-marker]").first()).toBeVisible();
      await shots(page, "html");
    });

    await test.step("an image: the picture, and a comment on the whole of it", async () => {
      await page.getByRole("link", { name: "Artifacts" }).first().click();
      await page.getByRole("link", { name: "token-timeline.png" }).click();
      await expect(page.getByRole("img", { name: "token-timeline.png" })).toBeVisible(HARD_LOAD);
      await panel(page).getByRole("button", { name: "Comment on the file" }).click();
      await page.locator("[data-comment-popover] textarea").fill("Mark where the CLI refreshes too.");
      await page.locator("[data-comment-popover]").getByRole("button", { name: /^Save|^Add/ }).click();
      await expect(card(page, "Mark where the CLI refreshes too.")).toBeVisible();
      await shots(page, "image");
    });

    expect(errors).toEqual([]);
  } finally {
    await made.machine?.api("DELETE", `/v1/monorepos/${full}?confirm=${full}`);
  }
});
