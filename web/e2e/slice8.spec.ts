// Slice 8, end to end: releases (research/plans/releases-2026-10-04, mocks
// research/design/pando-ui-2026-10-03/releases). A project's main is built
// by Buildkite (its stand-in) and released through the API: a release with a
// file and notes, published, and a draft. The project page's strip names
// main's state, the build and the latest release; the Releases tab lists
// both, newest first, the draft marked; the release page shows the file with
// its size and SHA-256, the notes through Plannotator's viewer, the commit
// and its checks; Download hands over the file's bytes. The file is members
// only until an owner turns on "Anyone can download releases" in Settings;
// then the same address answers without signing in. Publishing the draft
// while the tab is open moves Latest there, with no reload. A plain
// repository's empty tab gives the command, and its Settings one switch.
// PANDO_E2E_RELEASE_SHOTS=1 also saves Pando dark and light at 1440 and 390
// in e2e/shots/releases for a look beside the mocks.
// Real Worker, real D1, Durable Objects, R2 and Artifacts, real git, real browser.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { Buildkite } from "./buildkite";
import { BASE, browserPost, HARD_LOAD, Machine, nextSignIn } from "./seed";

const id = Date.now().toString(36);

const login = `rl-${id}`;

const name = `e2e-${id}`;

const plainName = `cli-${id}`;

const full = `${login}/${name}`;

const person = { id: `user_rl_${id}`, email: `${login}@pando.invalid`, email_verified: true, first_name: "Rel", last_name: "Lane" };

const repoApi = `/v1/monorepos/${full}/repos/projects-cli`;

const HELLO = "#!/bin/sh\necho hello from pando\n";

const SHOTS = new URL("shots/releases/", import.meta.url).pathname;

/** A JSON write as the browser session (booleans too; seed's browserPost sends strings). */
async function send(page: Page, method: "POST" | "PATCH", path: string, data: Record<string, string | boolean> = {}) {
  const res = await page.request.fetch(path, { method, data, headers: { origin: BASE } });

  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);

  return res.json();
}

/** The page never scrolls sideways. */
const fitsWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

interface Made {
  machine: Machine | null;
  buildkite: Buildkite | null;
  names: string[];
}

test("slice 8: releases: the strip, the Releases tab, a release's page, Download, the switch, a live publish, a phone", async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // 412: the on-merge step's Merge, refused while the checks it started run (an answer the page shows).
    if (m.type() === "error" && !/status of (401|404|412)/.test(m.text())) errors.push(m.text());
  });

  const made: Made = { machine: null, buildkite: null, names: [] };

  try {
    await nextSignIn(person);
    await page.goto(`${BASE}/login`);
    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(`${BASE}/`);

    let sha = "";
    const t0 = Date.now();
    const at = (ms: number) => new Date(t0 + ms).toISOString();

    await test.step("a project whose main Buildkite built, a release with a file, and a draft, made through the API", async () => {
      await browserPost(page, "/v1/monorepos", { name });
      made.names.push(name);
      const url = (await browserPost(page, `/v1/monorepos/${full}/repos`, { path: "projects/cli" })).clone_url;
      const m = await Machine.make(page, `laptop-${id}`, "Rel Lane");

      made.machine = m;
      const dir = m.commit("cli", url, "main", { "README.md": "# cli\n", "cmd/main.go": "package main\n" }, "Start the CLI");

      m.push(dir, url, "main");
      sha = m.git(dir, "rev-parse", "HEAD").trim();

      made.buildkite = await Buildkite.start();
      const bk = made.buildkite;
      const build = { commit: sha, branch: "main", message: "Start the CLI", created_at: at(-300_000), started_at: at(-290_000) };

      await bk.connect(m, full);
      await bk.pipeline(m, full, "projects-cli", "pando-ci");
      await bk.send("job.finished", "pando-ci", 142, { ...build, state: "running" }, { id: "job-ci", key: "ci", state: "passed", exit_status: 0, created_at: at(-290_000), started_at: at(-290_000), finished_at: at(-98_000) });
      await bk.send("build.finished", "pando-ci", 142, { ...build, state: "passed", finished_at: at(-97_000) });

      await send(page, "POST", `${repoApi}/releases`, { tag: "v0.1.0", title: "The first release", notes: "## Changes\n\n- Start the CLI (`start`) by rl, closes #1\n", draft: true });
      const put = await page.request.put(`${repoApi}/releases/v0.1.0/files/hello.sh`, { data: Buffer.from(HELLO), headers: { origin: BASE, "content-type": "text/x-sh" } });

      expect(put.status()).toBe(201);
      await send(page, "POST", `${repoApi}/releases/v0.1.0/publish`);
      await send(page, "POST", `${repoApi}/releases`, { tag: "v0.2.0", title: "Deployments", draft: true });
    });

    await test.step("the project page: main passed, its build with Buildkite's mark, the latest release", async () => {
      await page.goto(`${BASE}/${full}/projects/cli`);
      const strip = page.getByLabel("main's build and the latest release");

      await expect(strip).toBeVisible(HARD_LOAD);
      await expect(strip.getByText("passed", { exact: true })).toBeVisible();
      await expect(strip.getByRole("link", { name: "pando-ci #142" })).toHaveAttribute("href", `/${full}/ci/pando-ci/142`);
      await expect(strip.getByAltText("Buildkite")).toBeVisible();
      await expect(strip.getByText("Latest release")).toBeVisible();
      await expect(strip.getByRole("link", { name: "v0.1.0" })).toBeVisible();
      await expect(page.getByRole("link", { name: /^Releases/ })).toContainText("2");
    });

    await test.step("the Releases tab: newest first, the draft marked, the latest one with its file", async () => {
      await page.getByRole("link", { name: /^Releases/ }).click();
      await expect(page).toHaveURL(`${BASE}/${full}/projects/cli/releases`);
      const rows = page.getByRole("list", { name: "Releases" }).getByRole("listitem");

      await expect(rows).toHaveCount(2);
      await expect(rows.nth(0)).toContainText("v0.2.0");
      await expect(rows.nth(0)).toContainText("Draft");
      await expect(rows.nth(0)).toContainText("made");
      await expect(rows.nth(1)).toContainText("The first release");
      await expect(rows.nth(1)).toContainText("Latest");
      await expect(rows.nth(1)).toContainText("1 file");
      await expect(rows.nth(1)).toContainText(sha.slice(0, 7));
    });

    const fileHref = `${repoApi}/releases/v0.1.0/files/hello.sh`;

    await test.step("a release's page: its file with size and SHA-256, its notes, its commit and checks; Download hands over the bytes", async () => {
      await page.getByRole("list", { name: "Releases" }).getByRole("link", { name: /v0\.1\.0/ }).click();
      await expect(page.getByRole("heading", { name: "The first release" })).toBeVisible(HARD_LOAD);
      await expect(page.getByLabel("Where you are")).toContainText("v0.1.0");
      const files = page.getByRole("region", { name: "Files" });
      const sum = createHash("sha256").update(HELLO).digest("hex");

      await expect(files.getByText("hello.sh")).toBeVisible();
      await expect(files.getByText(`${Buffer.byteLength(HELLO)} bytes`)).toBeVisible();
      await expect(files.getByTitle(`SHA-256 ${sum}`)).toHaveText(sum.slice(0, 12));
      await expect(files.getByText("Members only")).toBeVisible();
      await expect(page.getByRole("region", { name: "Notes" }).getByRole("heading", { name: "Changes" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Notes" }).getByRole("link", { name: "#1" })).toHaveAttribute("href", `/${full}/issues/1`);
      const side = page.getByRole("complementary", { name: "Commit and checks" });

      // The commit opens its own page.
      await expect(side.getByRole("link", { name: sha.slice(0, 7) })).toHaveAttribute("href", `/${full}/projects/cli/commit/${sha}`);
      await expect(side.getByText("Start the CLI")).toBeVisible();
      await expect(side.getByRole("list", { name: "Checks" }).getByText("passed")).toBeVisible();
      await expect(side.getByRole("list", { name: "Checks" }).getByText("3 min 12 s")).toBeVisible();

      const download = page.waitForEvent("download");

      await files.getByRole("link", { name: "Download hello.sh" }).click();
      const got = await download;

      expect(got.suggestedFilename()).toBe("hello.sh");
      expect(readFileSync(await got.path(), "utf8")).toBe(HELLO);
      // Members only: the same address, without signing in, is refused.
      expect((await fetch(`${BASE}${fileHref}`)).status).not.toBe(200);
    });

    await test.step("a draft's page: no tag until published, the command that uploads its files", async () => {
      await page.goto(`${BASE}/${full}/projects/cli/releases/v0.2.0`);
      await expect(page.getByRole("heading", { name: "Deployments" })).toBeVisible(HARD_LOAD);
      await expect(page.getByText("no tag until published")).toBeVisible();
      await expect(page.getByText("pando release upload v0.2.0 dist/*")).toBeVisible();
    });

    await test.step("Settings: an owner turns on \"Anyone can download releases\"; the file then downloads without signing in", async () => {
      await page.goto(`${BASE}/${full}/settings`);
      const toggle = page.getByRole("switch", { name: "Anyone can download projects/cli's releases" });

      await expect(toggle).toBeEnabled(HARD_LOAD);
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect(page.getByRole("list", { name: "Anyone can download releases" }).getByText("Anyone", { exact: true })).toBeVisible();
      const open = await fetch(`${BASE}${fileHref}`);

      expect(open.status).toBe(200);
      expect(await open.text()).toBe(HELLO);
      // Code stays members only.
      expect((await fetch(`${BASE}/v1/monorepos/${full}/repos/projects-cli/tree`)).status).not.toBe(200);
      await page.reload();
      await expect(page.getByRole("switch", { name: "Anyone can download projects/cli's releases" })).toBeChecked(HARD_LOAD);
      await page.goto(`${BASE}/${full}/projects/cli/releases/v0.1.0`);
      await expect(page.getByRole("region", { name: "Files" }).getByText("Anyone can download")).toBeVisible(HARD_LOAD);
    });

    await test.step("Settings: when checks run, set to On merge; a push then builds nothing, and Merge starts the checks", async () => {
      await page.goto(`${BASE}/${full}/settings`);
      const policy = page.getByRole("combobox", { name: "When checks run for projects/cli" });

      await expect(policy).toHaveValue("every_push", HARD_LOAD);
      await policy.selectOption("on_merge");
      await expect.poll(async () => (await page.request.get(`${BASE}${repoApi}`)).json().then((r: { ci_policy?: string }) => r.ci_policy)).toBe("on_merge");
      await page.reload();
      await expect(page.getByRole("combobox", { name: "When checks run for projects/cli" })).toHaveValue("on_merge", HARD_LOAD);

      const m = made.machine!;
      const bk = made.buildkite!;
      const repo: { clone_url: string } = await (await page.request.get(`${BASE}${repoApi}`)).json();
      const url = repo.clone_url;
      const dir = m.commit("cli", url, "fix-help", { "cmd/help.go": "package main\n" }, "Fix the help text");

      m.push(dir, url, "fix-help");
      const head = m.git(dir, "rev-parse", "HEAD").trim();

      await page.goto(`${BASE}/${full}/projects/cli/branches/fix-help`);
      await expect(page.getByText("Checks run when you merge")).toBeVisible(HARD_LOAD);
      expect(bk.created.some((b) => b.commit === head)).toBe(false);
      await page.getByRole("button", { name: "Merge", exact: true }).click();
      await expect(page.getByText("Checks started for this merge")).toBeVisible();
      await expect.poll(() => bk.created.some((b) => b.commit === head && b.branch === "fix-help")).toBe(true);
      await page.goto(`${BASE}/${full}/settings`);
      await page.getByRole("combobox", { name: "When checks run for projects/cli" }).selectOption("every_push");
      await expect.poll(async () => (await page.request.get(`${BASE}${repoApi}`)).json().then((r: { ci_policy?: string }) => r.ci_policy)).toBe("every_push");
    });

    await test.step("publishing the draft while the tab is open moves Latest to it, with no reload", async () => {
      await page.goto(`${BASE}/${full}/projects/cli/releases`);
      const rows = page.getByRole("list", { name: "Releases" }).getByRole("listitem");

      await expect(rows.nth(0)).toContainText("Draft", HARD_LOAD);
      await page.waitForTimeout(1500);
      await send(page, "POST", `${repoApi}/releases/v0.2.0/publish`);
      await expect(rows.nth(0)).toContainText("Latest", { timeout: 30_000 });
      await expect(rows.nth(0)).not.toContainText("Draft");
      await expect(rows.nth(1)).not.toContainText("Latest");
    });

    await test.step("a phone: the tab and the release page fit, each file keeps its Download", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${BASE}/${full}/projects/cli/releases`);
      await expect(page.getByRole("list", { name: "Releases" })).toBeVisible(HARD_LOAD);
      expect(await fitsWidth(page)).toBe(true);
      await page.goto(`${BASE}/${full}/projects/cli/releases/v0.1.0`);
      await expect(page.getByRole("link", { name: "Download hello.sh" })).toBeVisible(HARD_LOAD);
      expect(await fitsWidth(page)).toBe(true);
      await page.goto(`${BASE}/${full}/projects/cli`);
      await expect(page.getByLabel("main's build and the latest release")).toBeVisible(HARD_LOAD);
      expect(await fitsWidth(page)).toBe(true);
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await test.step("a plain repository: an empty Releases tab gives the command; its Settings has one switch", async () => {
      await browserPost(page, "/v1/monorepos", { name: plainName, kind: "repo" });
      made.names.push(plainName);
      await page.goto(`${BASE}/${login}/${plainName}/releases`);
      await expect(page.getByText("No releases yet.")).toBeVisible(HARD_LOAD);
      await expect(page.getByText("pando release create v0.1.0 --generate")).toBeVisible();
      await page.goto(`${BASE}/${login}/${plainName}/settings`);
      await expect(page.getByRole("switch", { name: "Anyone can download releases" })).toBeEnabled(HARD_LOAD);
    });

    if (process.env.PANDO_E2E_RELEASE_SHOTS) {
      await test.step("shots: Pando dark and light, 1440 and 390", async () => {
        mkdirSync(SHOTS, { recursive: true });
        // A draft to show beside the published ones.
        await send(page, "POST", `${repoApi}/releases`, { tag: "v0.3.0", title: "Release files and the install command", draft: true });

        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });

          for (const theme of ["pando-dark", "pando-light"]) {
            const shot = async (file: string, route: string) => {
              await page.goto(`${BASE}${route}?theme=${theme}`);
              await page.waitForLoadState("networkidle");
              await page.waitForTimeout(500);
              await page.screenshot({ path: join(SHOTS, `${file}-${theme}-${width}.png`), fullPage: true });
            };

            await shot("code", `/${full}/projects/cli`);
            await shot("releases", `/${full}/projects/cli/releases`);
            await shot("release", `/${full}/projects/cli/releases/v0.1.0`);
            await shot("release-draft", `/${full}/projects/cli/releases/v0.3.0`);
            await shot("releases-empty", `/${login}/${plainName}/releases`);
            await shot("settings", `/${full}/settings`);
            await shot("settings-plain", `/${login}/${plainName}/settings`);
          }
        }
      });
    }

    expect(errors).toEqual([]);
  } finally {
    await made.buildkite?.close();

    for (const n of made.names) await made.machine?.api("DELETE", `/v1/monorepos/${login}/${n}?confirm=${login}/${n}`);
  }
});
