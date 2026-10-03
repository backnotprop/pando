// End-to-end tests: a real browser against the real Worker (wrangler dev with
// its local D1 and Durable Objects, real Artifacts, real git pushes), and a
// stand-in WorkOS on this machine for sign-in. Ports are in e2e/ports.ts; the
// Worker keeps its own --persist-to state. A server already on either port is
// an error, never reused, so a run never tests another lane's Worker.
//
// Before a run:
// - worker/.dev.vars in this worktree (gitignored; the owner's secrets, never
//   printed) with WORKOS_API_BASE pointing at the stand-in (e2e/ports.ts), and
//   PANDO_BOOTSTRAP, PANDO_STATUS_SECRET and WORKOS_API_KEY set;
// - your real HOME: wrangler dev reaches the real Artifacts service with your
//   `wrangler login`. (Git in the tests gets a temporary HOME of its own.)
import { defineConfig } from "@playwright/test";
import { INSPECTOR_PORT, STANDIN_PORT, WORKER_PORT } from "./e2e/ports.ts";

const state = "../web/e2e/.state/wrangler";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${WORKER_PORT}`, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  // `e2e` is the test; `shots` makes the fidelity screenshots for review (npm run shots).
  projects: [
    { name: "e2e", testMatch: /slice1\.spec\.ts/ },
    { name: "shots", testMatch: /fidelity\.spec\.ts/ },
  ],
  webServer: [
    { command: "node e2e/workos.ts", url: `http://127.0.0.1:${STANDIN_PORT}/healthz`, reuseExistingServer: false },
    {
      command: `npm run build && cd ../worker && npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to ${state} && npx wrangler dev --port ${WORKER_PORT} --inspector-port ${INSPECTOR_PORT} --persist-to ${state}`,
      url: `http://localhost:${WORKER_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
