// The agents' web slices (e2e/agents*.spec.ts): a real browser against Pando's
// Worker and pando-agents in one wrangler dev (the agents' containers in
// Docker, the scripted model from agents/.dev.vars), with the stand-in
// WorkOS. Ports from e2e/ports.ts (this lane: PANDO_E2E_WORKER_PORT=8863,
// stand-in 8864, inspector 9363); its own state. DOCKER_HOST must point at a
// Docker engine in a VM (agents/test/gate.sh starts the lane's Colima).
//   PANDO_E2E_WORKER_PORT=8863 PANDO_E2E_INSPECTOR_PORT=9363 npx playwright test -c playwright.agents.config.ts
import { defineConfig } from "@playwright/test";
import { INSPECTOR_PORT, STANDIN_PORT, WORKER_PORT } from "./e2e/ports.ts";

const state = "../web/e2e/.state/wrangler-agents";

export default defineConfig({
  testDir: "e2e",
  // PANDO_AGENTS_SHOTS=1: the shots for the owner's look (e2e/shots-agents.spec.ts) instead of the tests.
  testMatch: process.env.PANDO_AGENTS_SHOTS === "1" ? /\/e2e\/shots-agents\.spec\.ts$/ : /\/e2e\/agents[^/]*\.spec\.ts$/,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${WORKER_PORT}`, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  webServer: [
    { command: "node e2e/workos.ts", url: `http://127.0.0.1:${STANDIN_PORT}/healthz`, reuseExistingServer: false },
    {
      command: [
        "npm run build",
        "(grep -qs '^SCRIPTED_MODEL=1$' ../agents/.dev.vars || echo SCRIPTED_MODEL=1 >> ../agents/.dev.vars)",
        `cd ../worker && npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to ${state}`,
        `npx wrangler dev -c wrangler.jsonc -c ../agents/wrangler.jsonc --port ${WORKER_PORT} --inspector-port ${INSPECTOR_PORT} --persist-to ${state} --var DOCS_URL:http://127.0.0.1:${STANDIN_PORT}/docs-site --var WORKOS_API_BASE:http://127.0.0.1:${STANDIN_PORT} > ../web/e2e/.state/worker-agents.log 2>&1`,
      ].join(" && "),
      url: `http://localhost:${WORKER_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 600_000,
    },
  ],
});
