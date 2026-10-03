// The Worker's environment: bindings from wrangler.jsonc plus the secrets the
// owner sets with `wrangler secret put` (never in the repo). Secrets are
// optional here: the Worker answers clearly when one is not set.
type Secrets = "PANDO_BOOTSTRAP" | "BUILDKITE_API_TOKEN";

export interface Env extends Omit<Cloudflare.Env, Secrets> {
  /** Makes users (POST /v1/users) until a sign-in method exists. */
  PANDO_BOOTSTRAP?: string;
  /** Buildkite REST token (write_builds) for buildkite hooks. */
  BUILDKITE_API_TOKEN?: string;
}
