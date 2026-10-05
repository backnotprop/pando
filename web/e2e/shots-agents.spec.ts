// Shots of the built agents screens for the owner's look, not assertions:
// ramos/pando with ana as a member, sessions run by the scripted model (it
// reads its steps from the prompt, so the prompts show them). Into
// e2e/shots/agents/ (with shots.json, each file's caption): the Agents tab,
// New agent (a new and an existing name), an issue with Address with agent
// and its Agents block, the Address dialog, a branch with Review with agent
// (the dialog, a review agent at work and a posted review), a session's page
// live, the same read-only as ana, and the assistant (its button, a chat,
// Chats), in Pando dark and light at 1440 and 390.
//
//   PANDO_AGENTS_SHOTS=1 PANDO_SF_FONTS=1 npx playwright test -c playwright.agents.config.ts
import { type Browser, expect, type Page, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, browserPost, type JsonBody, Machine, nextSignIn } from "./seed";

const SHOTS = fileURLToPath(new URL("shots/agents/", import.meta.url));

const person = (login: string, first: string, last: string) => ({ id: `user_${login}_local`, email: `${login}@pando.invalid`, email_verified: true, first_name: first, last_name: last });

const ramos = person("ramos", "Michael", "Ramos");

const ana = person("ana", "Ana", "Lopes");

const FULL = "ramos/pando";

/** A tool call's arguments as the scripted model reads them. */
type ToolArgs = Record<string, string | number | readonly Record<string, string | number>[]>;

/** A line the scripted model reads as one tool call (agents/src/models.ts). */
const tool = (name: string, args: ToolArgs = {}) => `> ${name} ${JSON.stringify(args)}`;

const lines = (...l: string[]) => l.join("\n");

test.use({ deviceScaleFactor: 2 });

async function signIn(page: Page, who: typeof ramos) {
  await nextSignIn(who);
  await page.goto(`${BASE}/login`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
}

async function send(page: Page, method: "POST" | "PUT" | "PATCH", path: string, data: JsonBody) {
  const res = await page.request.fetch(path, { method, data, headers: { origin: BASE } });

  if (!res.ok() && res.status() !== 409) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);

  return res.json();
}

/** Session n once it is no longer working. */
async function settled(page: Page, n: number) {
  await expect.poll(async () => (await (await page.request.get(`/v1/monorepos/${FULL}/agents/${n}`)).json()).status, { timeout: 180_000 }).not.toBe("working");
}

/** Session n once its sandbox runs the long last step. */
async function running(page: Page, n: number, step: string) {
  await expect.poll(async () => JSON.stringify(await (await page.request.get(`/v1/monorepos/${FULL}/agents/${n}/transcript`)).json()).includes(step), { timeout: 180_000 }).toBe(true);
}

const settle = async (page: Page) => {
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => Promise.all([document.fonts.load('14px "SF Mono"'), document.fonts.load('14px "SF Pro Text"'), document.fonts.load('600 14px "SF Pro Text"')]));
  await page.waitForTimeout(900);
};

async function open(page: Page, route: string, theme: string) {
  await page.goto(`${route}${route.includes("?") ? "&" : "?"}theme=${theme}`);
  await settle(page);
}

async function anaPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ deviceScaleFactor: 2 });
  const page = await context.newPage();

  await signIn(page, ana);

  return page;
}

async function seed(page: Page, browser: Browser) {
  await page.request.delete(`/v1/monorepos/${FULL}?confirm=${FULL}`, { headers: { origin: BASE } });
  const made = await browserPost(page, "/v1/monorepos", { name: "pando", kind: "repo" });
  const url: string = made.repos[0].clone_url;
  const a = await anaPage(browser);

  await send(page, "PUT", `/v1/monorepos/${FULL}/members/ana`, { role: "member" });
  const mbp = await Machine.make(page, "ramos-mbp", "Michael Ramos");
  const dir = mbp.commit("r", url, "main", { "README.md": "# Pando\n\nA git platform for monorepos.\n", "web/index.html": "<!doctype html>\n<html>\n<body></body>\n</html>\n", "src/theme.ts": "export const theme = 'dark';\n" }, "first");

  mbp.push(dir, url, "main");
  mbp.commit("r", url, "api-pagination", { "src/api.ts": "export const PAGE = 50;\n// a tpyo here\n" }, "Page the API at 50");
  mbp.push(dir, url, "api-pagination");

  const ag = (body: JsonBody) => send(page, "POST", `/v1/monorepos/${FULL}/agents`, { model: "scripted", ...body });

  // #1: addressed and merged; #2: addressed, waiting for ramos; #3: open, for the dialog.
  await send(page, "POST", `/v1/monorepos/${FULL}/issues`, {
    title: "Login page flashes white in dark mode",
    body: lines(
      "The sign-in page shows white for a moment before the dark theme loads.",
      "",
      tool("read_file", { path: "web/index.html" }),
      tool("bash", { command: "printf '<!doctype html>\\n<html>\\n<script>document.documentElement.dataset.theme = localStorage.theme ?? \"dark\"</script>\\n<body></body>\\n</html>\\n' > web/index.html && git commit -qam 'Set the theme before the first paint' && git push -q origin HEAD" }),
      tool("comment_issue", { number: 1, body: "The theme is now set in a small inline script before the first paint." }),
      tool("merge"),
    ),
  });
  await send(page, "POST", `/v1/monorepos/${FULL}/issues/1/agent`, { model: "scripted" });
  await settled(page, 1);
  await send(page, "POST", `/v1/monorepos/${FULL}/issues`, {
    title: "Theme resets after signing out",
    body: lines("Signing out clears the saved theme.", "", tool("read_file", { path: "src/theme.ts" }), tool("bash", { command: "grep -rn theme src" }), tool("comment_issue", { number: 2, body: "Sign-out clears local storage; keeping the theme key would fix it. Shall I?" })),
  });
  await send(page, "POST", `/v1/monorepos/${FULL}/issues/2/agent`, { model: "scripted" });
  await settled(page, 2);
  await send(page, "POST", `/v1/monorepos/${FULL}/issues`, { title: "Search box loses focus after typing", body: "Typing a second letter in the search box drops the focus." });

  // #3: a review posted on api-pagination.
  await send(page, "POST", `/v1/monorepos/${FULL}/agents/review`, {
    branch: "api-pagination",
    model: "scripted",
    prompt: lines("Look at the comments too.", tool("branch_diff"), tool("post_review", { verdict: "request_changes", body: "A typo in a comment.", comments: [{ path: "src/api.ts", line: 2, body: "tpyo: typo" }] })),
  });
  await settled(page, 3);
  // #4: ana's task, waiting for her.
  await send(a, "POST", `/v1/monorepos/${FULL}/agents`, { model: "scripted", branch: "docs-search-box", prompt: lines("Add a search box to the docs.", tool("bash", { command: "ls" })) });
  await settled(page, 4);
  // #5: stopped by ramos.
  await ag({ branch: "theme-cache", prompt: lines("Cache the theme.", tool("bash", { command: "sleep 600" })) });
  await running(page, 5, "sleep 600");
  await send(page, "POST", `/v1/monorepos/${FULL}/agents/5/stop`, {});
  // #6: working now, a step running; #7: a review at work on api-pagination.
  await ag({ branch: "rate-limit-per-credential", prompt: lines("Limit requests per credential.", tool("read_file", { path: "README.md" }), tool("list_files", { path: "src" }), tool("bash", { command: "npm test 2>&1 | tail -3; sleep 900" })) });
  await send(page, "POST", `/v1/monorepos/${FULL}/agents/review`, { branch: "api-pagination", model: "scripted", prompt: lines("A second look.", tool("bash", { command: "sleep 900" })) });
  await running(page, 6, "sleep 900");
  // The assistant: one answered chat.
  await send(page, "POST", `/v1/monorepos/${FULL}/assistant`, { model: "scripted", prompt: lines("Where is the theme applied before the first paint?", tool("list_files", { path: "web" }), tool("read_file", { path: "web/index.html" })) });

  return a;
}

test("agents: shots of the built screens for the owner's look", async ({ page, browser }) => {
  test.setTimeout(1_500_000);
  mkdirSync(SHOTS, { recursive: true });
  await signIn(page, ramos);
  const a = await seed(page, browser);
  const shots: Record<string, string> = {};

  const shot = async (p: Page, file: string, caption: string, full = true) => {
    await p.screenshot({ path: join(SHOTS, file), fullPage: full });
    shots[file] = caption;
  };

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });

    for (const theme of ["pando-dark", "pando-light"]) {
      const at = `${theme}-${width}`;

      await open(page, `/${FULL}/agents`, theme);
      await shot(page, `agents-${at}.png`, `The Agents tab, ${at}`);

      await page.getByRole("button", { name: "New agent" }).click();
      await page.getByRole("dialog").getByRole("textbox").first().fill("Make the light theme the default.");
      await page.getByLabel("New branch name").fill("theme-light-default");
      await settle(page);
      await shot(page, `new-${at}.png`, `New agent, a new branch, ${at}`, false);
      await page.getByLabel("New branch name").fill("api-pagination");
      await settle(page);
      await shot(page, `new-exists-${at}.png`, `New agent, a name that exists, ${at}`, false);
      await page.keyboard.press("Escape");

      await open(page, `/${FULL}/issues/2`, theme);
      await shot(page, `issue-${at}.png`, `An issue with Address with agent and its Agents block, ${at}`);
      // The issue's header buttons (Edit, New issue, Address with agent) are not shown on a phone.
      if (width === 1440) {
        await open(page, `/${FULL}/issues/3`, theme);
        await page.getByRole("button", { name: "Address with agent" }).click();
        await settle(page);
        await shot(page, `issue-address-${at}.png`, `Address with agent, the branch from the issue, ${at}`, false);
        await page.keyboard.press("Escape");
      }

      await open(page, `/${FULL}/branches/api-pagination`, theme);
      await shot(page, `branch-review-${at}.png`, `A branch: Review with agent, a review agent at work, a posted review, ${at}`);
      await page.getByRole("button", { name: "Review with agent" }).click();
      await settle(page);
      await shot(page, `branch-review-dialog-${at}.png`, `Review with agent, the dialog, ${at}`, false);
      await page.keyboard.press("Escape");

      await open(page, `/${FULL}/agents/6`, theme);
      await shot(page, `session-${at}.png`, `A session's page, live, a step running, ${at}`, false);
      await open(page, `/${FULL}/agents/1`, theme);
      await shot(page, `session-done-${at}.png`, `A merged session, ${at}`, false);

      await a.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await open(a, `/${FULL}/agents/1`, theme);
      await shot(a, `session-readonly-${at}.png`, `ana reads ramos's session: no box, ${at}`, false);

      await open(page, `/${FULL}`, theme);
      await shot(page, `assistant-button-${at}.png`, `The assistant's button, ${at}`, false);
      await page.getByRole("button", { name: "Assistant" }).click();
      await page.getByRole("button", { name: "Chats" }).click();
      await settle(page);
      await shot(page, `assistant-chats-${at}.png`, `The assistant: Chats, ${at}`, false);
      await page.getByRole("list", { name: "Chats" }).getByRole("button").first().click();
      await settle(page);
      await shot(page, `assistant-chat-${at}.png`, `The assistant: a chat, ${at}`, false);
      await page.getByRole("button", { name: "Close" }).click();
    }
  }

  writeFileSync(join(SHOTS, "shots.json"), `${JSON.stringify(shots, null, 2)}\n`);
});
