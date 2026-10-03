// Names: monorepos, repos (path and URL name), Artifacts repos, branches.

export const ZERO = "0".repeat(40);
export const DEFAULT_BRANCH = "main";

const MONOREPO_RE = /^[a-z0-9](?:[a-z0-9._]|-(?!-)){0,38}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9._]|-(?!-))*$/;
const RESERVED_MONOREPOS = new Set(["v1", "healthz"]);
const SHA_RE = /^[0-9a-f]{40}$/;

export function isSha(s: string): boolean {
  return SHA_RE.test(s);
}

export function validMonorepoName(name: unknown): name is string {
  return typeof name === "string" && MONOREPO_RE.test(name) && !RESERVED_MONOREPOS.has(name);
}

/** A repo path from formats.md: `projects/web`, or `.` for a plain repo. */
export function validRepoPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 100) return false;
  if (path === ".") return true;
  return path.split("/").every((seg) => /^[A-Za-z0-9._-]+$/.test(seg) && seg !== "." && seg !== "..");
}

/** The URL name of a repo: its path with `/` turned into `-`, lower case. */
export function repoNameFor(monorepo: string, path: string): string | null {
  const slug = path === "." ? monorepo : path.replaceAll("/", "-").toLowerCase();
  if (!SLUG_RE.test(slug) || slug === "meta" || slug.length > 60) return null;
  return slug;
}

export function artifactsRepoName(monorepo: string, repoName: string): string {
  return `${monorepo}--${repoName}`;
}

export function metaArtifactsName(monorepo: string): string {
  return `${monorepo}--meta`;
}

/** git check-ref-format, for a branch name (without refs/heads/). */
export function validBranchName(b: unknown): b is string {
  if (typeof b !== "string" || b.length === 0 || b.length > 200) return false;
  if (b === "@" || b.startsWith("-") || b.startsWith("/") || b.endsWith("/") || b.endsWith(".")) return false;
  if (b.includes("..") || b.includes("//") || b.includes("@{")) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(b)) return false;
  return b.split("/").every((seg) => seg.length > 0 && !seg.startsWith(".") && !seg.endsWith(".lock"));
}
