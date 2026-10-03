// Talking to Artifacts: repo tokens the Worker mints for itself (never
// handed to a client, never logged), git requests to a repo's remote, and the
// repo's refs.

import type { Env } from "../env";
import { HttpError } from "../http";
import { parseAdvertisement, parseReport, updateRefsRequest, type RefCommand } from "./pktline";

export interface ArtifactsRef {
  artifacts_name: string;
  remote: string;
}

// Tokens are reused inside one isolate while they have at least 5 minutes
// left. They live 15 minutes and stay in memory only.
const TOKEN_TTL_SECONDS = 900;
const TOKEN_REUSE_MS = 5 * 60_000;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function repoToken(env: Env, name: string, scope: "read" | "write"): Promise<string> {
  const key = `${name}\n${scope}`;
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt - Date.now() > TOKEN_REUSE_MS) return hit.token;
  const t = await withRepo(env, name, (repo) => repo.createToken(scope, TOKEN_TTL_SECONDS));
  tokenCache.set(key, { token: t.plaintext, expiresAt: Date.parse(t.expiresAt) || Date.now() + TOKEN_TTL_SECONDS * 1000 });
  return t.plaintext;
}

/** A fresh read token for a hook delivery (30 minutes). Not cached. */
export async function deliveryReadToken(env: Env, name: string): Promise<{ token: string; expiresAt: string }> {
  const t = await withRepo(env, name, (repo) => repo.createToken("read", 1800));
  return { token: t.plaintext, expiresAt: t.expiresAt };
}

export async function withRepo<T>(env: Env, name: string, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
  let repo: ArtifactsRepo;
  try {
    repo = await env.ARTIFACTS.get(name);
  } catch (err) {
    throw artifactsError(err, `Artifacts repo ${name}`);
  }
  try {
    return await fn(repo);
  } finally {
    repo[Symbol.dispose]();
  }
}

export function artifactsError(err: unknown, what: string): HttpError {
  const code = (err as { code?: string })?.code;
  if (code === "NOT_FOUND") return new HttpError(404, "not_found", `${what} was not found`);
  if (code === "CREATE_IN_PROGRESS" || code === "IMPORT_IN_PROGRESS" || code === "FORK_IN_PROGRESS")
    return new HttpError(409, "not_ready", `${what} is still being created; retry`);
  const message = err instanceof Error ? err.message : String(err);
  return new HttpError(502, "artifacts", `${what}: ${code ?? ""} ${message}`.trim());
}

/** A git smart HTTP request to the repo's Artifacts remote. */
export async function gitRequest(
  env: Env,
  repo: ArtifactsRef,
  path: string,
  scope: "read" | "write",
  init: RequestInit & { headers?: Record<string, string> },
): Promise<Response> {
  const token = await repoToken(env, repo.artifacts_name, scope);
  return fetch(`${repo.remote}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
  });
}

/** Every ref in the repo (`refs/heads/main` -> sha). Empty for an empty repo. */
export async function listRefs(env: Env, repo: ArtifactsRef): Promise<Map<string, string>> {
  const res = await gitRequest(env, repo, "/info/refs?service=git-upload-pack", "read", { method: "GET" });
  if (!res.ok) throw new HttpError(502, "artifacts", `Artifacts answered ${res.status} listing refs`);
  return parseAdvertisement(new Uint8Array(await res.arrayBuffer()));
}

export function branchesOf(refs: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [ref, sha] of refs) if (ref.startsWith("refs/heads/")) out.set(ref.slice(11), sha);
  return out;
}

/** Move refs to commits that already exist (no new objects). */
export async function updateRefs(env: Env, repo: ArtifactsRef, commands: RefCommand[]): Promise<Map<string, string | null>> {
  const caps = ["report-status", "agent=pando"];
  const body = await updateRefsRequest(commands, caps);
  const res = await gitRequest(env, repo, "/git-receive-pack", "write", {
    method: "POST",
    headers: {
      "content-type": "application/x-git-receive-pack-request",
      accept: "application/x-git-receive-pack-result",
    },
    body,
  });
  if (!res.ok) throw new HttpError(502, "artifacts", `Artifacts answered ${res.status} to a ref update`);
  const report = parseReport(new Uint8Array(await res.arrayBuffer()), new Set(caps));
  if (report.unpack !== "ok") throw new HttpError(502, "artifacts", `Artifacts could not unpack: ${report.unpack}`);
  return report.refs;
}
