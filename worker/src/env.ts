// The Worker's environment: bindings from wrangler.jsonc plus the secrets the
// owner sets with `wrangler secret put` (never in the repo). Secrets are
// optional here: the Worker answers clearly when one is not set.
import type { AgentsRpc } from "../../agents/src/protocol";

type Secrets = "AGENTS" | "PANDO_BOOTSTRAP" | "BUILDKITE_API_TOKEN" | "PANDO_STATUS_SECRET" | "WORKOS_CLIENT_ID" | "WORKOS_API_KEY" | "WORKOS_API_BASE" | "HOOK_RETRY_DELAYS" | "GATE_RELEASE_MS" | "FEED_FANOUT_MAX" | "FEED_TICK_MS" | "FEED_TEST" | "FEED_RETRY_MS" | "DOOR_TEST" | "FILES_BUDGET" | "FACTS_RETRY_MS" | "FACTS_TEST" | "HOOKS_TEST" | "META_TEST" | "CHECKS_TEST" | "MIRROR_TEST" | "GITHUB_APP_SLUG" | "GITHUB_APP_CLIENT_ID" | "GITHUB_APP_CLIENT_SECRET" | "GITHUB_APP_PRIVATE_KEY" | "GITHUB_API_BASE" | "GITHUB_WEB_BASE" | "GITHUB_GIT_BASE" | "MIRROR_SPACING_MS" | "MIRROR_RETRY_MS";

export interface Env extends Omit<Cloudflare.Env, Secrets> {
  /** Which Worker version runs (wrangler.jsonc version_metadata): its tag is the commit deploy.sh deployed. */
  VERSION?: WorkerVersionMetadata;
  /** pando-agents' AgentsApi entrypoint: Cloudflare-run agents (agents/). Absent where pando-agents is not set up. */
  AGENTS?: Fetcher & AgentsRpc;
  /** Accounts (C8): users, credentials, monorepos, members, invites. D1 with read replication. */
  ACCOUNTS_DB: D1Database;
  /** Makes users (POST /v1/users) until a sign-in method exists. */
  PANDO_BOOTSTRAP?: string;
  /** Buildkite REST token: write_builds for buildkite hooks and the CI tab's actions, read scopes for its details (ci/). */
  BUILDKITE_API_TOKEN?: string;
  /** Signs PANDO_STATUS_TOKEN (ci/statustoken.ts). Rotating it ends every status token. */
  PANDO_STATUS_SECRET?: string;
  /** The WorkOS environment "Pando": pando login's device flow. */
  WORKOS_CLIENT_ID?: string;
  /** Its API key: the browser sign-in's code exchange. */
  WORKOS_API_KEY?: string;
  /** Tests only: a stand-in WorkOS on localhost (any other value is ignored). */
  WORKOS_API_BASE?: string;
  /** Tests only: hook retry delays in seconds, comma-separated (default 10,60,300,1800). */
  HOOK_RETRY_DELAYS?: string;
  /** Tests only: Artifacts reads a request's walk may spend (FILES.md), to force the queue path. */
  FILES_BUDGET?: string;
  /** Tests only: the facts outbox's retry delays in ms, comma-separated (default 5000,30000,300000). */
  FACTS_RETRY_MS?: string;
  /** Tests only: "1" lets testFactsOutbox fail drains on purpose. */
  FACTS_TEST?: string;
  /** Tests only: "1" opens /v1/_hooks/test (crash the object mid-delivery) and makes the delivery lease 6 s. Never set on a deployed Worker. */
  HOOKS_TEST?: string;
  /** Tests only: "1" opens /v1/_checks/test (the next reads of pando.toml fail). Never set on a deployed Worker. */
  CHECKS_TEST?: string;
  /** Tests only: "1" opens /v1/_meta/test (fail, lose or crash the meta layer's next event sends; fail its next updates from main). Never set on a deployed Worker. */
  META_TEST?: string;
  /** Tests only: "1" honours X-Pando-Test-Busy at the git door (the first receive-pack is taken as busy, unsent). */
  DOOR_TEST?: string;
  /** The write gate's release delay in ms (default gate.ts RELEASE_DELAY_MS). */
  GATE_RELEASE_MS?: string;
  /** Tests only (C25): the member count above which a monorepo is read on demand (default 100). */
  FEED_FANOUT_MAX?: string;
  /** Tests only (C25): the summary tick interval in ms (default 10 s, 60 s when large). */
  FEED_TICK_MS?: string;
  /** Tests only (C25): "1" opens /v1/_feed/test to the bootstrap secret. Never set on a deployed Worker. */
  FEED_TEST?: string;
  /** Tests only (C25): the outbox's retry delays in ms, comma-separated (default 1000,5000,30000,300000). */
  FEED_RETRY_MS?: string;
  /** Mirror to GitHub (mirror/): the GitHub App's address name, github.com/apps/<slug>. Not secret. */
  GITHUB_APP_SLUG?: string;
  /** The GitHub App's Client ID: the JWT's issuer and the OAuth client. Not secret. */
  GITHUB_APP_CLIENT_ID?: string;
  /** The GitHub App's client secret: trades the one-time authorization code at connect. */
  GITHUB_APP_CLIENT_SECRET?: string;
  /** The GitHub App's private key, PEM as GitHub gives it (PKCS#1) or PKCS#8. Signs the JWTs that mint installation tokens. */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** Tests only: a stand-in for api.github.com (any value not on localhost is ignored). */
  GITHUB_API_BASE?: string;
  /** Tests only: a stand-in for github.com's pages (authorize, install). */
  GITHUB_WEB_BASE?: string;
  /** Tests only: a stand-in for github.com's git (smart HTTP). */
  GITHUB_GIT_BASE?: string;
  /** Tests only: "1" opens /v1/_mirror/test to the bootstrap secret. Never set on a deployed Worker. */
  MIRROR_TEST?: string;
  /** Tests only: the least time between two runs for one GitHub repository, ms (default 10000). */
  MIRROR_SPACING_MS?: string;
  /** Tests only: the retry delays in ms, comma-separated (default 10000,60000,300000,1800000, then hourly). */
  MIRROR_RETRY_MS?: string;
}
