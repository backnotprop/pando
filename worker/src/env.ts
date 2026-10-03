// The Worker's environment: bindings from wrangler.jsonc plus the secrets the
// owner sets with `wrangler secret put` (never in the repo).
export interface Env extends Cloudflare.Env {
  /** The first admin credential: creates monorepos and their first token. */
  PANDO_BOOTSTRAP?: string;
  /** Buildkite REST token (write_builds) for buildkite hooks. */
  BUILDKITE_API_TOKEN?: string;
}
