// The Worker's environment: bindings from wrangler.jsonc plus the secrets the
// owner sets with `wrangler secret put` (never in the repo). Secrets are
// optional here: the Worker answers clearly when one is not set.
type Secrets = "PANDO_BOOTSTRAP" | "BUILDKITE_API_TOKEN" | "WORKOS_CLIENT_ID" | "WORKOS_API_KEY" | "WORKOS_API_BASE" | "HOOK_RETRY_DELAYS" | "GATE_RELEASE_MS" | "FEED_FANOUT_MAX" | "FEED_TICK_MS" | "FEED_TEST";

export interface Env extends Omit<Cloudflare.Env, Secrets> {
  /** Accounts (C8): users, credentials, monorepos, members, invites. D1 with read replication. */
  ACCOUNTS_DB: D1Database;
  /** Makes users (POST /v1/users) until a sign-in method exists. */
  PANDO_BOOTSTRAP?: string;
  /** Buildkite REST token (write_builds) for buildkite hooks. */
  BUILDKITE_API_TOKEN?: string;
  /** The WorkOS environment "Pando": pando login's device flow. */
  WORKOS_CLIENT_ID?: string;
  /** Its API key: the browser sign-in's code exchange. */
  WORKOS_API_KEY?: string;
  /** Tests only: a stand-in WorkOS on localhost (any other value is ignored). */
  WORKOS_API_BASE?: string;
  /** Tests only: hook retry delays in seconds, comma-separated (default 10,60,300,1800). */
  HOOK_RETRY_DELAYS?: string;
  /** The write gate's release delay in ms (default gate.ts RELEASE_DELAY_MS). */
  GATE_RELEASE_MS?: string;
  /** Tests only (C25): the member count above which a monorepo is read on demand (default 100). */
  FEED_FANOUT_MAX?: string;
  /** Tests only (C25): the summary tick interval in ms (default 10 s, 60 s when large). */
  FEED_TICK_MS?: string;
  /** Tests only (C25): "1" opens /v1/_feed/test to the bootstrap secret. Never set on a deployed Worker. */
  FEED_TEST?: string;
}
