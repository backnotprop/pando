// Buildkite, the first CI service (RESEARCH-2026-10-03 section 6): what
// Pando sends a build, and (ci/) what it reads back.

/**
 * A CI build's read token lives this long (pando-ops ruling, 2026-10-03):
 * Buildkite's Retry reruns a job with the build's original env, so the token
 * in it must outlive a day of retries. Read only, one repo. Artifacts allows
 * 60 s to 1 year. Minted for 25 hours and reused for at most 1, so every
 * build gets at least 24.
 */
export const CI_READ_TTL_S = 25 * 3600;
export const CI_READ_REUSE_MS = 3600_000;

/** The env Pando gives a build it starts (hook deliveries and Rebuild). */
export function pandoBuildEnv(v: {
  clone_url: string;
  read_token: string;
  status_url: string;
  status_token: string | null;
  monorepo: string;
  repo: string;
  branch: string;
  head: string;
  delivery: string;
  seq: number | null;
}): Record<string, string> {
  return {
    PANDO_CLONE_URL: v.clone_url,
    PANDO_READ_TOKEN: v.read_token,
    PANDO_STATUS_URL: v.status_url,
    ...(v.status_token ? { PANDO_STATUS_TOKEN: v.status_token } : {}),
    PANDO_MONOREPO: v.monorepo,
    PANDO_REPO: v.repo,
    PANDO_BRANCH: v.branch,
    PANDO_HEAD: v.head,
    PANDO_DELIVERY: v.delivery,
    PANDO_SEQ: v.seq === null ? "" : String(v.seq),
  };
}
