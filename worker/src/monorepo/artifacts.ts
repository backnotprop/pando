// Talking to Artifacts: repo tokens the Worker mints for itself (never
// handed to a client, never logged), git requests to a repo's remote, and the
// repo's refs.

import type { Env } from "../env";
import { HttpError } from "../http";
import { hasCode } from "../parse";
import { isBusy } from "./gate";
import { addArtifacts, currentTiming, timeArtifacts, timed, timedRepo, timedStub } from "../timing";
import { parseAdvertisement, parseReport, updateRefsRequest, type RefCommand } from "./pktline";

export interface ArtifactsRef {
  artifacts_name: string;
  remote: string;
  /** When Pando recorded the repo. A repo deleted and made again under the same name gets a new one. */
  created_at?: string;
}

// Tokens are reused inside one isolate while they have at least 5 minutes
// left. They live 15 minutes and stay in memory only.
const TOKEN_TTL_SECONDS = 900;

const TOKEN_REUSE_MS = 5 * 60_000;

/** A minted Artifacts token and when it expires (ms). */
export interface TokenEntry {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenEntry>();

/**
 * A repo token for the Worker's own git requests. Cached per isolate, keyed
 * by the repo's record too, so a token for a deleted repo is never reused for
 * a new repo of the same name.
 */
/**
 * Where a repo token comes from. "object": the monorepo object, which mints
 * one per repo and scope for the whole service (C3), so isolates do not each
 * mint their own. "local": mint with the binding here (the object itself).
 */
export type TokenSource = "object" | "local";

/** The monorepo of an Artifacts repo name (`<monorepo>--<repo>`; Pando names forbid "--"). */
function monorepoOf(artifactsName: string): string {
  return artifactsName.slice(0, artifactsName.indexOf("--"));
}

export async function repoTokenEntry(
  env: Env,
  name: string,
  scope: "read" | "write",
  generation = "",
  source: TokenSource = "object",
  fresh = false,
): Promise<TokenEntry> {
  const key = `${name}\n${scope}\n${generation}`;
  const hit = tokenCache.get(key);

  if (!fresh && hit && hit.expiresAt - Date.now() > TOKEN_REUSE_MS) return hit;
  let entry: TokenEntry;

  if (source === "local") {
    const mint = () => withRepo(env, name, (repo) => repo.createToken(scope, TOKEN_TTL_SECONDS));
    // Inside the monorepo object there is no request: a mint gets its own line.
    const t = currentTiming() ? await mint() : await timed("object", { route: "token.mint", repo: name, scope }, mint);
    entry = { token: t.plaintext, expiresAt: Date.parse(t.expiresAt) || Date.now() + TOKEN_TTL_SECONDS * 1000 };
  } else {
    const got = await timedStub(env.MONOREPO.getByName(monorepoOf(name))).artifactsToken(name, scope, generation, fresh);

    // A monorepo deleted moments ago, still in this isolate's caches: not a server error.
    if (!got) throw new HttpError(404, "not_found", "this monorepo was deleted");

    // A mint inside the object is Artifacts time on this request's line.
    if (got.mint_ms) addArtifacts("createToken (in the object)", name, Date.now() - got.mint_ms, Date.now());
    entry = { token: got.token, expiresAt: got.expiresAt };
  }

  tokenCache.set(key, entry);

  return entry;
}

export async function repoToken(env: Env, name: string, scope: "read" | "write", generation = "", source: TokenSource = "object", fresh = false): Promise<string> {
  return (await repoTokenEntry(env, name, scope, generation, source, fresh)).token;
}

/** A fresh read token for a hook delivery (30 minutes). Not cached. */
/** A read token for a hook delivery: 30 minutes for web hooks; CI deliveries pass a longer ttl (ci/statustoken.ts, CI_READ_TTL_S). */
export async function deliveryReadToken(env: Env, name: string, ttlS = 1800): Promise<{ token: string; expiresAt: string }> {
  const t = await withRepo(env, name, (repo) => repo.createToken("read", ttlS));

  return { token: t.plaintext, expiresAt: t.expiresAt };
}

export async function withRepo<T>(env: Env, name: string, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
  let repo: ArtifactsRepo;

  try {
    repo = await timeArtifacts("get", name, () => env.ARTIFACTS.get(name));
  } catch (err) {
    throw artifactsError(err, `Artifacts repo ${name}`);
  }

  try {
    // Every call on the handle is timed for the request's pando.timing line.
    return await fn(timedRepo(repo, name));
  } finally {
    repo[Symbol.dispose]();
  }
}

/**
 * An Artifacts error's code. Across RPC (and through wrangler dev's remote
 * binding) the `code` property can be lost, so the message is read too.
 */
export function artifactsCode(cause: unknown): string | null {
  if (hasCode(cause) && cause.code) return cause.code;
  const m = cause instanceof Error ? cause.message : String(cause);

  if (/already exists/i.test(m)) return "ALREADY_EXISTS";

  if (/not found|does not exist|no such repo/i.test(m)) return "NOT_FOUND";

  if (/import(ing)? in progress/i.test(m)) return "IMPORT_IN_PROGRESS";

  if (/fork(ing)? in progress/i.test(m)) return "FORK_IN_PROGRESS";

  if (/in progress|not ready/i.test(m)) return "CREATE_IN_PROGRESS";

  if (/invalid repo name|INVALID_REPO_NAME/i.test(m)) return "INVALID_REPO_NAME";

  return null;
}

export function artifactsError(cause: unknown, what: string): HttpError {
  const code = artifactsCode(cause);

  if (code === "NOT_FOUND") return new HttpError(404, "not_found", `${what} was not found`);

  if (code === "CREATE_IN_PROGRESS" || code === "IMPORT_IN_PROGRESS" || code === "FORK_IN_PROGRESS")
    return new HttpError(409, "not_ready", `${what} is still being created; retry`);
  const message = cause instanceof Error ? cause.message : String(cause);

  return new HttpError(502, "artifacts", `${what}: ${code ?? ""} ${message}`.trim());
}

/** A git smart HTTP request to the repo's Artifacts remote. */
export async function gitRequest(
  env: Env,
  repo: ArtifactsRef,
  path: string,
  scope: "read" | "write",
  init: RequestInit & { headers?: Record<string, string> },
  source: TokenSource = "object",
): Promise<Response> {
  const op = `http ${init.method ?? "GET"} ${path.split("?")[0].replace(/^\//, "")}`;

  const send = async (fresh: boolean) => {
    const token = await repoToken(env, repo.artifacts_name, scope, repo.created_at, source, fresh);

    // Until the response headers; a body read after is timed by its reader.
    return timeArtifacts(op, repo.artifacts_name, () =>
      fetch(`${repo.remote}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } }),
    );
  };

  const res = await send(false);

  // A cached token Artifacts no longer accepts: mint a new one and retry once,
  // when the request body can be sent again (not a stream).
  if ((res.status === 401 || res.status === 403) && !(init.body instanceof ReadableStream)) {
    await res.body?.cancel();

    return send(true);
  }

  return res;
}

/** Every ref in the repo (`refs/heads/main` -> sha). Empty for an empty repo. */
export async function listRefs(env: Env, repo: ArtifactsRef, source: TokenSource = "object"): Promise<Map<string, string>> {
  const res = await gitRequest(env, repo, "/info/refs?service=git-upload-pack", "read", { method: "GET" }, source);

  if (!res.ok) throw new HttpError(502, "artifacts", `Artifacts answered ${res.status} listing refs`);
  const bytes = await timeArtifacts("http GET info/refs (body)", repo.artifacts_name, () => res.arrayBuffer());

  return parseAdvertisement(new Uint8Array(bytes));
}

/** Every tag (`v0.1.0`): what its ref points at (`object`) and the commit it names (an annotated tag peeled). One info/refs read. */
export async function tagCommits(env: Env, repo: ArtifactsRef, source: TokenSource = "object"): Promise<Map<string, { object: string; commit: string }>> {
  const res = await gitRequest(env, repo, "/info/refs?service=git-upload-pack", "read", { method: "GET" }, source);

  if (!res.ok) throw new HttpError(502, "artifacts", `Artifacts answered ${res.status} listing refs`);
  const refs = parseAdvertisement(new Uint8Array(await timeArtifacts("http GET info/refs (body)", repo.artifacts_name, () => res.arrayBuffer())), true);
  const out = new Map<string, { object: string; commit: string }>();

  for (const [ref, sha] of refs) {
    if (ref.startsWith("refs/tags/") && !ref.endsWith("^{}")) out.set(ref.slice(10), { object: sha, commit: refs.get(`${ref}^{}`) ?? sha });
  }

  return out;
}

export function branchesOf(refs: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();

  for (const [ref, sha] of refs) if (ref.startsWith("refs/heads/")) out.set(ref.slice(11), sha);

  return out;
}

/** Move refs to commits that already exist (no new objects). */
export async function updateRefs(env: Env, repo: ArtifactsRef, commands: RefCommand[], source: TokenSource = "object"): Promise<Map<string, string | null>> {
  const caps = ["report-status", "agent=pando"];
  const body = await updateRefsRequest(commands, caps);

  const res = await gitRequest(
    env,
    repo,
    "/git-receive-pack",
    "write",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-git-receive-pack-request",
        accept: "application/x-git-receive-pack-result",
      },
      body,
    },
    source,
  );

  if (!res.ok) throw new HttpError(502, "artifacts", `Artifacts answered ${res.status} to a ref update`);

  const report = parseReport(
    new Uint8Array(await timeArtifacts("http POST git-receive-pack (body)", repo.artifacts_name, () => res.arrayBuffer())),
    new Set(caps),
  );

  if (report.error) {
    const busy = isBusy(report.error);
    throw new HttpError(busy ? 503 : 502, busy ? "repo_busy" : "artifacts", `Artifacts refused the write: ${report.error}`);
  }

  if (report.unpack !== "ok") throw new HttpError(502, "artifacts", `Artifacts could not unpack: ${report.unpack}`);

  return report.refs;
}
