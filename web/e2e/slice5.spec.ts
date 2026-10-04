// Slice 5, end to end: organizations. A person makes one from the name menu
// (the name checked as they type: its characters, reserved, taken), makes a repository
// in it (`pando init --owner`, here through the same API call), and adds a
// second person by login on People; she sees the repository on the org's
// page and opens it. The repository's Members tab lists her "From {org}",
// with no Remove. A person's own repository moves into the org from its
// Settings, and its old address still opens it. The org's details change in
// its Settings. The only owner can neither leave nor step down. Real Worker,
// real D1, real browser.
import { expect, type Page, test } from "@playwright/test";
import { BASE, browserPost, HARD_LOAD, nextSignIn } from "./seed";

const id = Date.now().toString(36);

const ops = { id: `user_ops_${id}`, email: `ops-${id}@pando.invalid`, email_verified: true, first_name: "Ops", last_name: "Lane" };

const bea = { id: `user_bea_${id}`, email: `bea-${id}@pando.invalid`, email_verified: true, first_name: "Bea", last_name: "Lane" };

const login = `ops-${id}`;

const beaLogin = `bea-${id}`;

const org = `team-${id}`;

const repo = `app-${id}`;

const solo = `solo-${id}`;

async function signIn(page: Page, person: typeof ops) {
  await nextSignIn(person);
  await page.goto(`${BASE}/login`);
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${BASE}/`);
}

/** Deletes a monorepo as the signed-in person; a missing one is fine. */
async function drop(page: Page, full: string) {
  await page.request.delete(`/v1/monorepos/${full}?confirm=${full}`, { headers: { origin: BASE } });
}

test("slice 5: organizations, their people and repositories, Members by org, transfer, the last owner", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];

  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // 404: a free name while New organization checks it; 409: the refusals this test asks for.
    if (m.type() === "error" && !/status of (401|404|409)/.test(m.text())) errors.push(m.text());
  });

  // Bea signs in once, in her own browser, so she has an account; her window stays open.
  const hers = await browser.newContext();
  const beaPage = await hers.newPage();

  try {
    await signIn(beaPage, bea);
    await signIn(page, ops);

    await test.step("New organization from the name menu: the name is checked as you type, a reserved one refused", async () => {
      await page.getByRole("button", { name: login, exact: true }).click();
      await page.getByRole("menuitem", { name: "New organization" }).click();
      await expect(page).toHaveURL(`${BASE}/orgs/new`);
      const name = page.getByRole("textbox", { name: "Name", exact: true });

      await name.fill("Bad--Name");
      await expect(page.getByText(/^Use lowercase letters, digits and single hyphens/)).toBeVisible();
      await name.fill(login);
      await expect(page.getByText(`${login} is taken.`)).toBeVisible();
      await name.fill("settings");
      await expect(page.getByText("settings is reserved: Pando uses it for its own pages.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Create organization" })).toBeDisabled();
      await name.fill(org.toUpperCase());
      await expect(name).toHaveValue(org);
      await expect(page.getByText(`${org} is available.`)).toBeVisible();
      await page.getByRole("textbox", { name: "Display name" }).fill(`Team ${id}`);
      await page.getByRole("button", { name: "Create organization" }).click();
      await expect(page).toHaveURL(`${BASE}/${org}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(`Team ${id}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(org);
      const tabs = page.getByRole("navigation", { name: `Organization ${org}` });

      await expect(tabs.getByRole("link", { name: "People" })).toHaveText(/1$/);
      await expect(tabs.getByRole("link", { name: "Settings" })).toBeVisible();
      await expect(page.getByRole("complementary", { name: `About ${org}` }).getByText("Owner", { exact: true })).toBeVisible();
      // The name menu lists it now.
      await page.getByRole("button", { name: login, exact: true }).click();
      await expect(page.getByRole("menuitem", { name: `Team ${id}` })).toBeVisible();
      await page.keyboard.press("Escape");
    });

    await test.step("a repository in the org: its page lists it, with the command that makes one", async () => {
      await expect(page.getByText(`pando init --owner ${org}`, { exact: true })).toBeVisible();
      await browserPost(page, "/v1/monorepos", { name: repo, owner: org });
      await page.reload();
      const list = page.getByRole("region", { name: "Repositories" });

      // On the org's own page a row names the repository alone (links R: GitHub-style rows).
      await expect(list.getByRole("link", { name: repo, exact: true })).toBeVisible();
      await expect(page.getByText("1 repository", { exact: true })).toBeVisible();
    });

    await test.step("its row counts open issues; on the home the row leads with the owner's avatar, the org's square", async () => {
      await browserPost(page, `/v1/monorepos/${org}/${repo}/issues`, { title: "Search misses exact names" });
      const row = page.getByRole("region", { name: "Repositories" }).getByRole("listitem").filter({ hasText: repo });

      await expect(async () => {
        await page.reload();
        await expect(row).toContainText("1 open issue", { timeout: 2000 });
      }).toPass({ timeout: 30_000 });
      await row.getByRole("link", { name: "1 open issue" }).click();
      await expect(page).toHaveURL(`${BASE}/${org}/${repo}/issues`);
      await page.goto(`${BASE}/`);
      const home = page.getByRole("list", { name: "Repositories" }).getByRole("listitem").filter({ hasText: `${org}/${repo}` });
      const avatar = await home.locator("[data-slot]").first().evaluate((el) => ({ text: el.textContent, radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) }));

      // The org's initials (team-…: "T" and the id's first letter), on a rounded square, not the repository's (app-…).
      expect(avatar.text).toBe(`T${id[0]?.toUpperCase()}`);
      expect(avatar.radius).toBeLessThan(8);
      await page.goto(`${BASE}/${org}`);
    });

    await test.step("a one-line description set in the repository's Settings shows on the org page's row", async () => {
      await page.goto(`${BASE}/${org}/${repo}/settings`);
      await page.getByRole("textbox", { name: "Description" }).fill("The web app, its API and the sync engine.");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
      // The header says it too.
      await expect(page.getByText("The web app, its API and the sync engine.", { exact: true }).first()).toBeVisible();
      await page.goto(`${BASE}/${org}`);
      await expect(page.getByRole("region", { name: "Repositories" }).getByRole("listitem").filter({ hasText: repo })).toContainText("The web app, its API and the sync engine.");
    });

    await test.step("People: add a second person by login", async () => {
      await page.getByRole("navigation", { name: `Organization ${org}` }).getByRole("link", { name: "People" }).click();
      await expect(page).toHaveURL(`${BASE}/orgs/${org}/people`);
      await page.getByRole("textbox", { name: "Email or login" }).fill(beaLogin);
      await page.getByRole("button", { name: "Invite", exact: true }).click();
      await expect(page.getByText(`Bea Lane is in ${org} now.`)).toBeVisible();
      const people = page.getByRole("list", { name: `People in ${org}` });

      await expect(people.getByRole("listitem")).toHaveCount(2);
      await expect(people.getByRole("listitem").filter({ hasText: beaLogin }).getByRole("combobox", { name: `Role of ${beaLogin}` })).toHaveValue("member");
    });

    await test.step("the second person sees the org's repository and opens it", async () => {
      await beaPage.goto(`${BASE}/${org}`);
      await expect(beaPage.getByRole("heading", { level: 1 })).toContainText(`Team ${id}`, HARD_LOAD);
      await expect(beaPage.getByRole("complementary", { name: `About ${org}` }).getByText("Member", { exact: true })).toBeVisible();
      // A member sees People but not Settings.
      const tabs = beaPage.getByRole("navigation", { name: `Organization ${org}` });

      await expect(tabs.getByRole("link", { name: "People" })).toHaveText(/2$/);
      await expect(tabs.getByRole("link", { name: "Settings" })).toHaveCount(0);
      await beaPage.getByRole("region", { name: "Repositories" }).getByRole("link", { name: repo, exact: true }).click();
      await expect(beaPage).toHaveURL(`${BASE}/${org}/${repo}`);
      await expect(beaPage.getByRole("heading", { level: 1 })).toContainText(`${org}/${repo}`);
      // Her home lists it too.
      await beaPage.goto(`${BASE}/`);
      await expect(beaPage.getByRole("link", { name: new RegExp(`${org}/${repo}`) }).first()).toBeVisible(HARD_LOAD);
    });

    await test.step('the repository\'s Members: "From {org}" first, without Remove; then "Added here"', async () => {
      await page.goto(`${BASE}/${org}/${repo}/members`);
      await expect(page.getByRole("heading", { name: new RegExp(`^From ${org}`) })).toBeVisible(HARD_LOAD);
      const fromOrg = page.getByRole("list", { name: `From ${org}` });
      const her = fromOrg.getByRole("listitem").filter({ hasText: beaLogin });

      await expect(her.getByText(`member, by ${org}`, { exact: true })).toBeVisible();
      await expect(her.getByRole("button", { name: `Remove ${beaLogin}` })).toHaveCount(0);
      await expect(page.getByRole("link", { name: `Manage in ${org}` })).toBeVisible();
      // ops made it, so ops also has a row of their own here.
      await expect(page.getByRole("list", { name: "Added here" }).getByRole("listitem").filter({ hasText: login })).toBeVisible();
    });

    await test.step("transfer a person's repository into the org; the old address still opens it", async () => {
      await browserPost(page, "/v1/monorepos", { name: solo });
      await page.goto(`${BASE}/${login}/${solo}/settings`);
      const owner = page.getByRole("combobox", { name: "New owner" });

      await expect(owner).toHaveValue(org, HARD_LOAD);
      await expect(page.getByText(`${login}/${solo} will be ${org}/${solo}. The old address keeps working.`)).toBeVisible();
      const button = page.getByRole("button", { name: "Transfer", exact: true });

      await expect(button).toBeDisabled();
      await page.getByRole("textbox", { name: `Type ${login}/${solo} to transfer` }).fill(`${login}/${solo}`);
      await button.click();
      await expect(page).toHaveURL(`${BASE}/${org}/${solo}/settings`);
      await page.goto(`${BASE}/${login}/${solo}`);
      await expect(page).toHaveURL(`${BASE}/${org}/${solo}`, HARD_LOAD);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(`${org}/${solo}`);
      // Everyone in the org has it now.
      await beaPage.goto(`${BASE}/${org}`);
      await expect(beaPage.getByRole("region", { name: "Repositories" }).getByRole("link", { name: solo, exact: true })).toBeVisible(HARD_LOAD);
    });

    await test.step("Settings: the org's description and website show on its page", async () => {
      await page.goto(`${BASE}/orgs/${org}/settings`);
      await page.getByRole("textbox", { name: "Description" }).fill("Plan review for coding agents.");
      await page.getByRole("textbox", { name: "Website" }).fill("https://example.com");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Saved.")).toBeVisible();
      await page.getByRole("navigation", { name: `Organization ${org}` }).getByRole("link", { name: "Overview" }).click();
      await expect(page.getByText("Plan review for coding agents.")).toBeVisible();
      await expect(page.getByRole("link", { name: "example.com" })).toHaveAttribute("href", "https://example.com");
    });

    await test.step("the only owner can't leave, or step down", async () => {
      await page.goto(`${BASE}/orgs/${org}/people`);
      await page.getByRole("button", { name: `Leave ${org}` }).click();
      await expect(page.getByRole("alert")).toHaveText(`You are the only owner of ${org}. Make someone else an owner before you leave.`);
      await page.getByRole("combobox", { name: `Role of ${login}` }).selectOption("member");
      await expect(page.getByRole("alert").filter({ hasText: "needs an owner" })).toHaveText(`${org} needs an owner. Make someone else an owner first.`);
      await expect(page.getByRole("combobox", { name: `Role of ${login}` })).toHaveValue("owner");
      expect((await page.request.get(`/v1/orgs/${org}`)).ok()).toBe(true);
    });

    expect(errors).toEqual([]);
  } finally {
    await drop(page, `${org}/${repo}`);
    await drop(page, `${org}/${solo}`);
    await hers.close();
  }
});
