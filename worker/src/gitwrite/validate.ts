// Input checks shared by mergeCommit and commitChanges.
import type { Signature } from "./objects";
import { GitWriteError } from "./repo";

const bad = (msg: string) => new GitWriteError("invalid_input", msg);

// A control character (below U+0020, or U+007F) or a space: git
// check-ref-format refuses them in a ref name.
function hasControlOrSpace(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);

    if (c <= 0x20 || c === 0x7f) return true;
  }

  return false;
}

// A required string field: present and not empty ("head is required").
export function checkPresent(v: unknown, field: string): asserts v is string {
  if (typeof v !== "string" || !v) throw bad(`${field} is required`);
}

// A commit message: a string that is not blank.
export function checkMessage(v: unknown): asserts v is string {
  if (typeof v !== "string" || !v.trim()) throw bad("message is required");
}

// A file write's content: text or bytes.
export function checkContent(v: unknown, path: string): asserts v is string | Uint8Array {
  if (typeof v !== "string" && !(v instanceof Uint8Array)) throw bad(`${path}: content must be a string or Uint8Array`);
}

// A short branch name ("main", "agent/ana/login"), checked like
// git check-ref-format.
export function checkBranchName(name: unknown, field: string): asserts name is string {
  checkPresent(name, field);

  if (
    name.startsWith("refs/") ||
    name.startsWith("/") ||
    name.startsWith("-") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("//") ||
    name.includes("@{") ||
    name === "@" ||
    /^[0-9a-f]{40}$/.test(name) ||
    hasControlOrSpace(name) ||
    /[~^:?*[\\]/.test(name) ||
    name.split("/").some((part) => part.startsWith("."))
  ) {
    throw bad(`${field} is not a valid branch name: ${JSON.stringify(name)}`);
  }
}

export function checkSignature(s: unknown, field: string): asserts s is Signature {
  if (typeof s !== "object" || s === null || !("name" in s) || !("email" in s) || typeof s.name !== "string" || typeof s.email !== "string") {
    throw bad(`${field} needs { name, email }`);
  }

  if (!s.name.trim()) throw bad(`${field}.name is empty`);

  if (/[<>\n\0]/.test(s.name) || /[<>\n\0]/.test(s.email)) {
    throw bad(`${field} must not contain <, > or a newline`);
  }

  if ("date" in s && s.date !== undefined && (!(s.date instanceof Date) || Number.isNaN(s.date.getTime()))) {
    throw bad(`${field}.date must be a valid Date`);
  }
}

// A change's path: a string, not empty.
export function checkPath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !path) throw bad("a change has no path");
}

// A repository-relative path, split into its segments.
export function splitPath(path: string): string[] {
  if (!path) throw bad("a change has no path");
  const parts = path.split("/");

  for (const p of parts) {
    if (!p || p === "." || p === ".." || p.toLowerCase() === ".git" || p.includes("\0")) {
      throw bad(`bad path: ${JSON.stringify(path)}`);
    }
  }

  return parts;
}
