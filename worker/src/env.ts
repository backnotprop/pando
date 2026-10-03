// The Worker's environment: bindings from wrangler.jsonc plus the secrets the
// owner sets with `wrangler secret put` (never in the repo). Secrets are
// optional here: the Worker answers clearly when one is not set.
type Secrets = "PANDO_BOOTSTRAP" | "BUILDKITE_API_TOKEN" | "WORKOS_CLIENT_ID" | "WORKOS_API_KEY";

export interface Env extends Omit<Cloudflare.Env, Secrets> {
  /** Makes users (POST /v1/users) until a sign-in method exists. */
  PANDO_BOOTSTRAP?: string;
  /** Buildkite REST token (write_builds) for buildkite hooks. */
  BUILDKITE_API_TOKEN?: string;
  /** The WorkOS environment "Pando": pando login's device flow. */
  WORKOS_CLIENT_ID?: string;
  /** Its API key. Not needed by the device flow; kept for later WorkOS calls. */
  WORKOS_API_KEY?: string;
}
