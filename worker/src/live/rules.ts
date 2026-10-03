// What may be saved in the meta layer. The Go client (cli/internal/meta/rules.go)
// applies the same rules before sending; the object applies them again.
// See docs/contracts/meta-sync.md, "What may be saved".

export const MAX_BYTES = 1_572_864; // 1.5 MiB: Durable Object rows hold 2 MB
const BINARY_SNIFF = 8000; // git's test: a NUL in the first 8,000 bytes

export type Refusal = {
  reason: "protected" | "not_meta" | "local_only" | "too_large" | "binary" | "bad_path" | "bad_sha" | "missing_blob";
  status: number;
  message: string;
};

// Folders whose contents never leave the machine, at any depth.
const LOCAL_DIRS = new Set([
  "node_modules",
  ".pnpm-store",
  "dist",
  "build",
  ".wrangler",
  ".next",
  ".cache",
  "__pycache__",
  ".venv",
  ".secrets",
  ".git",
]);

const LOCAL_SUFFIXES = [
  ".ndjson",
  ".jsonl",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".keystore",
  ".mobileprovision",
  ".provisionprofile",
  ".swp",
  "~",
  // databases change under a running program; a copy of one is not a database
  ".sqlite",
  ".sqlite3",
  ".sqlite-wal",
  ".sqlite-shm",
  ".sqlite-journal",
  ".db",
  ".db-wal",
  ".db-shm",
];
const LOCAL_PREFIXES = [".env", ".dev.vars", "id_rsa", "id_ed25519", "id_ecdsa", ".#"];

export function localOnlyName(name: string): boolean {
  if (name === ".DS_Store") return true;
  if (LOCAL_PREFIXES.some((p) => name.startsWith(p))) return true;
  if (LOCAL_SUFFIXES.some((s) => name.endsWith(s))) return true;
  if (name.includes(".conflict-local-")) return true; // Pando's conflict copies
  if (name.startsWith(".") && name.includes(".pando-tmp-")) return true; // Pando's temp files
  return false;
}

export function localOnlyDir(name: string): boolean {
  return LOCAL_DIRS.has(name);
}

// checkPath returns why a path may not be saved live, or null when it may.
export function checkPath(path: unknown): Refusal | null {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) {
    return { reason: "bad_path", status: 400, message: "a path is 1 to 1,024 bytes" };
  }
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return { reason: "bad_path", status: 400, message: "a path is relative, with / separators" };
  }
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    return { reason: "bad_path", status: 400, message: "no empty, . or .. segments" };
  }
  if (parts[0] === ".pando") {
    if (parts[1] === "local") {
      return { reason: "local_only", status: 403, message: ".pando/local/ is this machine only" };
    }
    // Reference pointers are live (formats.md, section 4); the rest of
    // .pando/ changes only through a reviewed branch.
    if (!(parts[1] === "references" && parts.length > 2)) {
      return { reason: "protected", status: 403, message: ".pando/ changes only through a reviewed branch" };
    }
  }
  if (parts[0] === "projects") {
    return { reason: "not_meta", status: 403, message: "projects/ holds code repos, which are not live" };
  }
  if (parts.slice(0, -1).some(localOnlyDir) || localOnlyName(parts[parts.length - 1])) {
    return { reason: "local_only", status: 403, message: "this path stays on the machine that made it" };
  }
  return null;
}

export function checkBytes(bytes: Uint8Array): Refusal | null {
  if (bytes.length > MAX_BYTES) {
    return { reason: "too_large", status: 413, message: "files over 1.5 MiB go to R2: send a pointer" };
  }
  const n = Math.min(bytes.length, BINARY_SNIFF);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return { reason: "binary", status: 415, message: "binary files go to R2: send a pointer" };
  }
  return null;
}
