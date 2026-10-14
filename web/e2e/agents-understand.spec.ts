// Understand, end to end in a real browser (docs/understand/BRIEF.md, the
// approved mock understand-v2.html): Ann's monorepo has a decision in its
// shared files, an issue, and a recorded Pi session whose edit became a commit
// on rate-limit, merged into main. The page reads as an essay with exhibits:
// the question as the title, the lines with the commit that last changed each,
// the paragraphs with their cites drawn as the records' names, each record
// under the paragraph that first cites it (the decision's words, the session's
// prompt and step, the commit line), "How this was found" folded, the
// follow-up box. Then nothing found; the ways in: Why? on lines chosen in Files
// changed, Why? on a commit, and Open as a page from the assistant. Dark and
// light. The scripted model (agents/.dev.vars) writes the paragraphs.
//   PANDO_E2E_WORKER_PORT=8927 PANDO_E2E_STANDIN_PORT=8928 PANDO_E2E_INSPECTOR_PORT=9427 npx playwright test -c playwright.agents.config.ts e2e/agents-understand.spec.ts
import { expect, type Page, test } from "@playwright/test";
import { BASE, browserPost, type JsonBody, Machine, nextSignIn, saveRootFiles } from "./seed";
import { naming, sessionId } from "./sessions-seed";

const id = Date.now().toString(36);

const ann = { id: `user_ann_${id}`, email: `ann-${id}@pando.invalid`, email_verified: true, first_name: "Ann", last_name: "Lane" };

const SHOTS = new URL("../../../../../../research/design/pando-understand-2026-10-14/shots/", import.meta.url).pathname;

/** A line the scripted model reads as one tool call (agents/src/models.ts). */
const tool = (name: string, args: JsonBody) => `> ${name} ${JSON.stringify(args)}`;

const LIMIT_V1 = "export function limited(count: number) {\n  return count > 100;\n}\n\nexport const RETRY_AFTER = 7;\nexport const RETRY_JITTER = 0.3;\n";

const LIMIT_V2 = `// 100 a minute per machine (decisions/0010-rate-limit.md).\nexport const RATE_LIMIT = 100;\nexport const WINDOW_MS = 60_000;\n\n${LIMIT_V1}`;

const DECISION = "# 0010: The API's rate limit\n\n## Decision\n\n100 requests a minute per machine, counted over a sliding one-minute window.\nA burst above it gets 429 with Retry-After. Bursts of 400 a minute from one\nmachine took the API down (#1).\n";

const PROMPT = "Apply decisions/0010-rate-limit.md to the API: 100 a minute per machine, a one-minute window. Put the numbers in src/limit.ts with a comment pointing at the decision. It fixes #1.";

/** A write with a nested JSON body (a question with its scope), as the browser session. */
async function ask(page: Page, path: string, data: JsonBody) {
  const res = await page.request.post(path, { data, headers: { origin: BASE } });

  if (!res.ok()) throw new Error(`${path}: ${res.status()} ${await res.text()}`);

  return res.json();
}

async function signIn(page: Page) {
  await nextSignIn(ann);
  await page.goto(`${BASE}/login`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
}

/** A recorded Pi session: the prompt, then its edit of src/limit.ts, two minutes ago. */
async function recordTurn(secret: string, full: string, repo: string): Promise<string> {
  const agentId = `0199-und-${id}`;
  const t = (s: number) => new Date(Date.now() - 120_000 + s * 1000).toISOString();

  const lines = [
    { type: "session", version: 3, id: agentId, timestamp: t(0), cwd: "/Users/ann/shop" },
    { type: "model_change", id: "m1", parentId: null, timestamp: t(0), provider: "anthropic", modelId: "claude-opus-5-5" },
    { type: "message", id: "u1", parentId: "m1", timestamp: t(1), message: { role: "user", content: [{ type: "text", text: PROMPT }], timestamp: Date.parse(t(1)) } },
    { type: "message", id: "a1", parentId: "u1", timestamp: t(5), message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "/Users/ann/shop/projects/api/src/limit.ts", oldText: "export function", newText: "// 100 a minute" } }], provider: "anthropic", model: "claude-opus-5-5", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, stopReason: "toolUse", timestamp: Date.parse(t(5)) } },
    { type: "message", id: "r1", parentId: "a1", timestamp: t(6), message: { role: "toolResult", toolCallId: "c1", toolName: "edit", content: [{ type: "text", text: "Edited." }], isError: false, timestamp: Date.parse(t(6)) } },
  ];

  const body = `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`;
  const sid = sessionId("pi", agentId);

  const res = await fetch(`${BASE}/v1/monorepos/${full}/sessions/${sid}/pieces?at=0&next=${Buffer.byteLength(body)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/x-ndjson", "pando-session": JSON.stringify({ program: "pi", agent_id: agentId, repo, branch: "rate-limit", parent: null }) },
    body,
  });

  if (!res.ok) throw new Error(`recording: ${res.status} ${await res.text()}`);

  return sid;
}

/** Where the open page was asked (its record, read through the API: a page building shows its progress there instead). */
async function askedFrom(page: Page, full: string) {
  const n = Number(new URL(page.url()).pathname.split("/").at(-1));

  return (await (await page.request.get(`${BASE}/v1/monorepos/${full}/understand/${n}`)).json()).from;
}

/** The page until its status reads `status` (it is live; this only waits). */
async function until(page: Page, status: string) {
  await expect(page.locator("article[data-status]")).toHaveAttribute("data-status", status, { timeout: 120_000 });
}

test("understand: the page as an essay with exhibits, nothing found, and its ways in", async ({ page }) => {
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|404|409)/.test(m.text())) errors.push(m.text());
  });

  await signIn(page);
  const made = await browserPost(page, "/v1/monorepos", { name: `und-${id}`, kind: "monorepo" });
  const full: string = made.monorepo.full_name;
  const project = await browserPost(page, `/v1/monorepos/${full}/repos`, { path: "projects/api" });
  const repo: string = project.name;
  const url: string = project.clone_url;
  const cred = await browserPost(page, "/v1/user/credentials", { name: "ann-mbp", kind: "machine" });
  const mbp = new Machine(cred.secret, "ann-mbp", "Ann Lane");

  mbp.push(mbp.commit("api", url, "main", { "src/limit.ts": LIMIT_V1, "README.md": "# API\n" }, "first"), url, "main");
  await saveRootFiles(page, full, "ann-mbp", { "decisions/0010-rate-limit.md": DECISION });
  await browserPost(page, `/v1/monorepos/${full}/issues`, { title: "Bursts from the CLI hit 429 and then 502", body: "One machine sent about 400 requests a minute during a sync." });
  const sid = await recordTurn(cred.secret, full, repo);
  const dir = mbp.commit("api", url, "rate-limit", { "src/limit.ts": LIMIT_V2 }, naming("Rate limit: 100 a minute per machine", sid));

  mbp.push(dir, url, "rate-limit");
  await browserPost(page, `/v1/monorepos/${full}/repos/${repo}/branches/rate-limit/merge`, {});

  // ── Complete: asked through the API with the scripted model's lines, then read in the browser ──
  const asked = await ask(page, `/v1/monorepos/${full}/understand`, {
    question: [
      "Why are lines 1 to 7 of src/limit.ts the way they are?",
      tool("place", {
        blocks: [
          { id: "p1", type: "paragraph", text: "The limit is 100 a minute because ramos decided it in [r5], after one machine's sync took the API down for everyone ([r4])." },
          { id: "p2", type: "paragraph", text: "Ann asked for exactly this in [r3], and its edit became commit [r1], which wrote lines 1 to 4." },
          { id: "p3", type: "paragraph", text: "One thing does not match: limited() counts every request, while the decision counts per machine. Those lines came with the project's first commit, [r2], before the decision." },
        ],
      }),
    ].join("\n"),
    scope: { kind: "lines", repo, path: "src/limit.ts", ref: "main", start: 1, end: 7 },
    model: "scripted",
  });

  await page.goto(`${BASE}/${full}/understand/${asked.number}`);
  await until(page, "complete");
  const article = page.locator("article[data-status]");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Why are lines 1 to 7 of src/limit.ts the way they are?");
  await expect(article).toContainText(/ann-\w+ asked, .*\. Scripted \(tests\) answered from Pando's records\./);
  await page.screenshot({ path: `${SHOTS}e2e-complete-dark-first.png`, fullPage: true });
  // The lines, each run with the commit that last changed it.
  const lines = page.getByLabel("The lines asked about, with the commit that last changed each");

  await expect(lines).toContainText("export const RATE_LIMIT = 100;");
  await expect(page.getByLabel("Last changed in")).toContainText(/[0-9a-f]{7}[\s\S]*[0-9a-f]{7}/);
  // The paragraphs, their cites drawn as the records' names.
  const p1 = page.locator("[data-block=p1]");

  await expect(p1).toContainText("decided it in decisions/0010-rate-limit.md, after");
  await expect(p1.getByRole("link", { name: /#1/ })).toBeVisible();
  await expect(p1.getByRole("region", { name: "decisions/0010-rate-limit.md" })).toContainText("100 requests a minute per machine");
  await expect(p1.getByRole("region", { name: "decisions/0010-rate-limit.md" })).toContainText("version 1, saved by");
  const p2 = page.locator("[data-block=p2]");

  await expect(p2).toContainText("in prompt 1 of");
  await expect(p2).toContainText("Pi session");
  await expect(p2).toContainText(PROMPT);
  await expect(p2).toContainText("Edit src/limit.ts");
  await expect(p2).toContainText("Rate limit: 100 a minute per machine");
  await expect(p2).toContainText(/committed with Pi and claude-opus-5-5 on /);
  await expect(page.locator("[data-block=p3]")).toContainText("No session or agent is recorded on it.");
  // Issues are links, not records; no record twice.
  await expect(page.locator("section[aria-label^='Issue']")).toHaveCount(0);
  await expect(page.locator("section[id^=source-]")).toHaveCount(4);
  // How this was found: folded, then open.
  await expect(page.getByText("Blamed lines 1 to 7 of src/limit.ts")).toBeHidden();
  await page.getByText("How this was found").click();
  await expect(page.getByText(/Blamed lines 1 to 7 of src\/limit\.ts: 2 commits/)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask a follow-up" })).toBeVisible();
  await page.getByText("How this was found").click();
  await page.screenshot({ path: `${SHOTS}e2e-complete-dark.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "pando-light"));
  await page.screenshot({ path: `${SHOTS}e2e-complete-light.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

  // A follow-up from the box: it is sent, and the page builds again and settles.
  await page.getByRole("textbox", { name: "Ask a follow-up" }).fill("Who decided the one-minute window?");
  const sent = page.waitForResponse((r) => r.url().endsWith(`/understand/${asked.number}/follow-ups`) && r.request().method() === "POST");

  await page.getByRole("button", { name: "Ask", exact: true }).click();
  expect((await sent).status()).toBe(200);
  await until(page, "complete");
  await expect(page.getByRole("textbox", { name: "Ask a follow-up" })).toHaveValue("");
  // A follow-up whose model replaces p3 (sent with the scripted model's line, which a one-line box cannot hold): the open page updates live.
  await browserPost(page, `/v1/monorepos/${full}/understand/${asked.number}/follow-ups`, {
    question: ["Should limited() count per machine?", tool("place", { blocks: [{ id: "p3", type: "paragraph", text: "Yes: the decision counts per machine ([r5]); limited() came earlier, with [r2]." }] })].join("\n"),
  });
  await expect(page.locator("[data-block=p3]")).toContainText("Yes: the decision counts per machine", { timeout: 60_000 });

  // ── Nothing found ──
  const none = await ask(page, `/v1/monorepos/${full}/understand`, {
    question: ["Why are lines 9 to 10 of src/limit.ts the way they are?", tool("place", { blocks: [{ id: "n1", type: "nothing", text: "They came with the project's first commit, [r1], which names no session, issue or shared file." }] })].join("\n"),
    scope: { kind: "lines", repo, path: "src/limit.ts", ref: "main", start: 9, end: 10 },
    model: "scripted",
  });

  await page.goto(`${BASE}/${full}/understand/${none.number}`);
  await until(page, "complete");
  await expect(page.locator("[data-block=n1]")).toContainText("No record explains these lines. They came with the project's first commit,");
  await expect(page.getByRole("button", { name: "Ask the assistant what this code does" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Ask a follow-up" })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}e2e-nothing-dark.png`, fullPage: true });

  // ── The ways in: Why? on a commit ──
  const read = await (await page.request.get(`${BASE}/v1/monorepos/${full}/understand/${asked.number}`)).json();
  const wrote: string = read.refs.find((r: { id: string }) => r.id === "r1").card.sha;

  await page.goto(`${BASE}/${full}/projects/api/commit/${wrote}`);
  await page.getByRole("button", { name: "Why?" }).click();
  await expect(page).toHaveURL(new RegExp(`/${full}/understand/\\d+$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Why was commit [0-9a-f]{7} made\?$/);
  expect(await askedFrom(page, full)).toEqual({ kind: "commit", branch: null });

  // Why? on lines chosen in Files changed: a line number, then shift and another.
  await page.goto(`${BASE}/${full}/projects/api/branches/rate-limit?tab=files`);
  const numbers = page.locator("[data-column-number]");

  await numbers.filter({ hasText: /^1$/ }).first().click();
  await numbers.filter({ hasText: /^3$/ }).first().click({ modifiers: ["Shift"] });
  await expect(page.getByText("Lines 1 to 3 of src/limit.ts")).toBeVisible();
  await page.getByRole("button", { name: "Why?" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Why are lines 1 to 3 of src/limit.ts the way they are?");
  expect(await askedFrom(page, full)).toEqual({ kind: "files_changed", branch: "rate-limit" });
  await expect(page.getByLabel("Last changed in")).toContainText(/[0-9a-f]{7}/);

  // Open as a page, from the assistant's chat.
  const chat = await browserPost(page, `/v1/monorepos/${full}/assistant`, { model: "scripted", prompt: "Why is the rate limit 100 a minute?" });

  await page.goto(`${BASE}/${full}`);
  await page.getByRole("button", { name: "Assistant" }).click();
  const panel = page.getByRole("complementary", { name: "Assistant" });

  await panel.getByRole("button", { name: "Chats" }).click();
  await page.getByRole("list", { name: "Chats" }).getByRole("button").first().click();
  await panel.getByRole("button", { name: "Open as a page" }).click({ timeout: 120_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Why is the rate limit 100 a minute?");
  // Asked with the default model (the page has no model choice): its answer is not waited for here.
  expect(await askedFrom(page, full)).toEqual({ kind: "assistant", branch: null });
  expect(chat.number).toBeGreaterThan(0);

  // The list: every page, newest first.
  await page.goto(`${BASE}/${full}/understand`);
  await expect(page.getByRole("list", { name: "Pages" }).getByRole("listitem")).toHaveCount(5);

  expect(errors).toEqual([]);
});
