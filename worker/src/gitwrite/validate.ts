// Input checks shared by mergeCommit and commitChanges.
import type { Signature } from "./objects";
import { GitWriteError } from "./repo";

const bad = (msg: string) => new GitWriteError("invalid_input", msg);

// A short branch name ("main", "agent/ana/login"), checked like
// git check-ref-format.
export function checkBranchName(name: unknown, field: string): asserts name is string {
  if (typeof name !== "string" || !name) throw bad(`${field} is required`);
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
    /[\x00-\x20\x7f~^:?*[\\]/.test(name) ||
    name.split("/").some((part) => part.startsWith("."))
  ) {
    throw bad(`${field} is not a valid branch name: ${JSON.stringify(name)}`);
  }
}

export function checkSignature(s: unknown, field: string): asserts s is Signature {
  const sig = s as Signature;
  if (!sig || typeof sig.name !== "string" || typeof sig.email !== "string") {
    throw bad(`${field} needs { name, email }`);
  }
  if (!sig.name.trim()) throw bad(`${field}.name is empty`);
  if (/[<>\n\0]/.test(sig.name) || /[<>\n\0]/.test(sig.email)) {
    throw bad(`${field} must not contain <, > or a newline`);
  }
  if (sig.date !== undefined && (!(sig.date instanceof Date) || Number.isNaN(sig.date.getTime()))) {
    throw bad(`${field}.date must be a valid Date`);
  }
}

// A repository-relative path, split into its segments.
export function splitPath(path: unknown): string[] {
  if (typeof path !== "string" || !path) throw bad("a change has no path");
  const parts = path.split("/");
  for (const p of parts) {
    if (!p || p === "." || p === ".." || p.toLowerCase() === ".git" || p.includes("\0")) {
      throw bad(`bad path: ${JSON.stringify(path)}`);
    }
  }
  return parts;
}
