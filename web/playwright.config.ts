// End-to-end tests: a real browser against the real Worker (wrangler dev with
// its local D1 and Durable Objects, real Artifacts, real git pushes), and a
// stand-in WorkOS on this machine for sign-in, which also serves the docs
// site's What's new (the Worker's DOCS_URL points at it). Ports are in
// e2e/ports.ts; the Worker keeps its own --persist-to state. A server already
// on either port is an error, never reused, so a run never tests another
// lane's Worker.
//
// Before a run:
// - worker/.dev.vars in this worktree (gitignored; the owner's secrets, never
//   printed) with WORKOS_API_BASE pointing at the stand-in (e2e/ports.ts), and
//   PANDO_BOOTSTRAP, PANDO_STATUS_SECRET and WORKOS_API_KEY set;
// - your real HOME: wrangler dev reaches the real Artifacts service with your
//   `wrangler login`. (Git in the tests gets a temporary HOME of its own.)
// The Worker below builds the app first, with this process's environment:
// `npm run shots` sets PANDO_SF_FONTS=1, so the shots use the same fonts as
// the prototype. A monorepo of more than FEED_FANOUT_MAX members is large
// (its lines reach the home by its own socket): 1 for the e2e, so two people
// make one large; the shots keep the server's own 100 (PANDO_E2E_FEED_FANOUT_MAX).
import { defineConfig } from "@playwright/test";
import { INSPECTOR_PORT, STANDIN_PORT, WORKER_PORT } from "./e2e/ports.ts";

const state = "../web/e2e/.state/wrangler";

// The Worker's stdout (its pando.timing lines, one per request), for the run's slowest read (e2e/reads.ts). Its errors stay on stderr, shown here.
const log = "../web/e2e/.state/worker.log";

const fanout = Number(process.env.PANDO_E2E_FEED_FANOUT_MAX ?? 1);

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"], ["./e2e/reads.ts"]],
  use: { baseURL: `http://localhost:${WORKER_PORT}`, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  // `e2e` is the test; `shots` makes the fidelity screenshots for review (npm run shots); `org-shots` the org screens'.
  projects: [
    { name: "e2e", testMatch: /slice\d\.spec\.ts/ },
    { name: "shots", testMatch: /fidelity\.spec\.ts/ },
    { name: "org-shots", testMatch: /orgs-shots\.spec\.ts/ },
  ],
  webServer: [
    { command: "node e2e/workos.ts", url: `http://127.0.0.1:${STANDIN_PORT}/healthz`, reuseExistingServer: false },
    {
      command: `npm run build && cd ../worker && npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to ${state} && npx wrangler dev --port ${WORKER_PORT} --inspector-port ${INSPECTOR_PORT} --persist-to ${state} --var DOCS_URL:http://127.0.0.1:${STANDIN_PORT}/docs-site --var FEED_FANOUT_MAX:${fanout} > ${log}`,
      url: `http://localhost:${WORKER_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
