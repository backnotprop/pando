// Names: namespaces (people and orgs), monorepos, repos (path and URL name),
// Artifacts repos, branches.
//
// A monorepo is `owner/name` (NAMESPACES.md): the name is unique within its
// owner, and a permanent id keys everything stored (objects, Artifacts, R2,
// queues). Monorepos made before namespaces keep their old name as their id.

export const ZERO = "0".repeat(40);
export const DEFAULT_BRANCH = "main";

const MONOREPO_RE = /^[a-z0-9](?:[a-z0-9._]|-(?!-)){0,38}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9._]|-(?!-))*$/;
/** A namespace (a login or an org): 1 to 39 of a-z, 0-9 and single hyphens, no hyphen at either end. */
const NAMESPACE_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
/** A namespace takes the first URL segment: never one of the Worker's own paths or the web app's top-level pages. */
export const RESERVED_NAMESPACES = new Set([
  "v1", "healthz", "login", "logout", "settings", "assets", "fonts", "new", "api", "app", "static", "orgs", "users",
]);
const SHA_RE = /^[0-9a-f]{40}$/;

export function isSha(s: string): boolean {
  return SHA_RE.test(s);
}

export function validMonorepoName(name: unknown): name is string {
  return typeof name === "string" && MONOREPO_RE.test(name);
}

/** Why a namespace name can't be used, or null when it can (whether it is free is the database's to say). */
export function namespaceProblem(name: unknown): "invalid" | "reserved" | null {
  if (typeof name !== "string" || !NAMESPACE_RE.test(name)) return "invalid";
  return RESERVED_NAMESPACES.has(name) ? "reserved" : null;
}

export function validNamespace(name: unknown): name is string {
  return namespaceProblem(name) === null;
}

/** A path's owner and monorepo name, matched case-insensitively (stored lower case). Null if either can't be a name. */
export function monorepoRef(owner: string | undefined, name: string | undefined): { owner: string; name: string } | null {
  const o = (owner ?? "").toLowerCase();
  const n = (name ?? "").toLowerCase();
  return NAMESPACE_RE.test(o) && validMonorepoName(n) ? { owner: o, name: n } : null;
}

/** A new monorepo's permanent id: m_ and 16 hex characters. */
export function newMonorepoId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return "m_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
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

/** A repo's Artifacts name, made once from the monorepo's id and kept on its record. */
export function artifactsRepoName(monorepoId: string, repoName: string): string {
  return `${monorepoId}--${repoName}`;
}

/** The meta layer's Artifacts repo, from the monorepo's id. */
export function metaArtifactsName(monorepoId: string): string {
  return `${monorepoId}--meta`;
}

/** git check-ref-format, for a branch name (without refs/heads/). */
export function validBranchName(b: unknown): b is string {
  if (typeof b !== "string" || b.length === 0 || b.length > 200) return false;
  if (b === "@" || b.startsWith("-") || b.startsWith("/") || b.endsWith("/") || b.endsWith(".")) return false;
  if (b.includes("..") || b.includes("//") || b.includes("@{")) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(b)) return false;
  return b.split("/").every((seg) => seg.length > 0 && !seg.startsWith(".") && !seg.endsWith(".lock"));
}
