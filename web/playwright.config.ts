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
//
// Mirror to GitHub (`--project=mirror`, e2e/mirror.spec.ts) needs GitHub's
// stand-in (worker/test/git-standin.mjs, which the spec starts on
// PANDO_E2E_GITHUB_PORT): with that set, the Worker gets the GitHub App's
// test settings pointing at it, a key made for this run (the spec gives the
// stand-in its public half through PANDO_E2E_GITHUB_KEY), the WorkOS
// stand-in's address, and state of its own.
import { generateKeyPairSync } from "node:crypto";
import { defineConfig } from "@playwright/test";
import { GITHUB_PORT, INSPECTOR_PORT, STANDIN_PORT, WORKER_PORT } from "./e2e/ports.ts";

const state = GITHUB_PORT ? "../web/e2e/.state/wrangler-mirror" : "../web/e2e/.state/wrangler";

// The Worker's stdout (its pando.timing lines, one per request), for the run's slowest read (e2e/reads.ts). Its errors stay on stderr, shown here.
const log = "../web/e2e/.state/worker.log";

const fanout = Number(process.env.PANDO_E2E_FEED_FANOUT_MAX ?? 1);

// One key per run: the test processes inherit it from this one.
if (GITHUB_PORT) process.env.PANDO_E2E_GITHUB_KEY ??= generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const github = GITHUB_PORT
  ? [
      "MIRROR_TEST:1",
      `GITHUB_API_BASE:http://127.0.0.1:${GITHUB_PORT}/api`,
      `GITHUB_WEB_BASE:http://127.0.0.1:${GITHUB_PORT}/web`,
      `GITHUB_GIT_BASE:http://127.0.0.1:${GITHUB_PORT}/git`,
      "GITHUB_APP_SLUG:pando-test",
      "GITHUB_APP_CLIENT_ID:Iv-test",
      "GITHUB_APP_CLIENT_SECRET:test-secret",
      `GITHUB_APP_PRIVATE_KEY:${Buffer.from(process.env.PANDO_E2E_GITHUB_KEY ?? "").toString("base64")}`,
      "MIRROR_SPACING_MS:1000",
      "MIRROR_RETRY_MS:1000,2000",
      `WORKOS_API_BASE:http://127.0.0.1:${STANDIN_PORT}`,
    ]
      .map((v) => ` --var ${v}`)
      .join("")
  : "";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"], ["./e2e/reads.ts"]],
  use: { baseURL: `http://localhost:${WORKER_PORT}`, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  // `e2e` is the test; `shots` makes the fidelity screenshots for review (npm run shots); `org-shots` the org screens', `profile-shots` the profile's; `mirror` is Mirror to GitHub against its stand-in (PANDO_E2E_GITHUB_PORT).
  projects: [
    { name: "e2e", testMatch: /slice\d\.spec\.ts/ },
    // Artifacts on a branch's page: documents, comments, versions (research/plans/artifacts-2026-10-12/SPEC.md).
    { name: "artifacts", testMatch: /artifacts\.spec\.ts/ },
    { name: "shots", testMatch: /fidelity\.spec\.ts/ },
    { name: "org-shots", testMatch: /orgs-shots\.spec\.ts/ },
    { name: "mirror", testMatch: /mirror\.spec\.ts/ },
    { name: "profile-shots", testMatch: /profile-shots\.spec\.ts/ },
    // Recorded agent sessions (the sessions lane): the checks, and the built pages' shots for the owner's look.
    { name: "sessions", testMatch: /sessions\.spec\.ts/, grepInvert: /shots of the built pages/ },
    { name: "sessions-shots", testMatch: /sessions\.spec\.ts/, grep: /shots of the built pages/ },
  ],
  webServer: [
    { command: "node e2e/workos.ts", url: `http://127.0.0.1:${STANDIN_PORT}/healthz`, reuseExistingServer: false },
    {
      command: `npm run build && cd ../worker && npx wrangler d1 migrations apply pando-accounts-dev --local --persist-to ${state} && npx wrangler dev --port ${WORKER_PORT} --inspector-port ${INSPECTOR_PORT} --persist-to ${state} --var DOCS_URL:http://127.0.0.1:${STANDIN_PORT}/docs-site --var FEED_FANOUT_MAX:${fanout}${github} > ${log}`,
      url: `http://localhost:${WORKER_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
