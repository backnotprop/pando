// End-to-end tests: a real browser against the real Worker (wrangler dev with
// its local D1 and Durable Objects, real Artifacts, real git pushes), and a
// stand-in WorkOS on this machine for sign-in. This lane's ports: 8813 for the
// Worker (its own --persist-to state), 8814 for the stand-in.
import { defineConfig } from "@playwright/test";

const state = "../web/e2e/.state/wrangler";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:8813", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  // `e2e` is the test; `shots` makes the fidelity screenshots for review (npm run shots).
  projects: [
    { name: "e2e", testMatch: /slice1\.spec\.ts/ },
    { name: "shots", testMatch: /fidelity\.spec\.ts/ },
  ],
  webServer: [
    { command: "node e2e/workos.ts", url: "http://127.0.0.1:8814/healthz", reuseExistingServer: true },
    {
      command: `npm run build && cd ../worker && npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to ${state} && npx wrangler dev --port 8813 --inspector-port 9341 --persist-to ${state}`,
      url: "http://localhost:8813/healthz",
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
