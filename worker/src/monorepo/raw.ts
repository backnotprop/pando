// Raw files (FILES.md section 3): GET or HEAD
//   /{owner}/{monorepo}/projects/{project}/raw/{path}?ref=   a monorepo's project: the repo at projects/{project}
//   /{owner}/{name}/raw/{path}?ref=                       a plain repo
//   /{owner}/{monorepo}/raw/{path}?v=                     a monorepo's own files (the meta layer), now or at a version
// The cookie (same origin; a read needs no Origin check) or a Bearer
// credential. Pinned to a sha: cached a year in the browser; by branch:
// revalidated by ETag (the blob's oid), so a repeat is a 304. Served so that
// nothing runs (files.ts rawResponse).

import type { Env } from "../env";
import { blobKey } from "../live/blobs";
import { HttpError, toErrorResponse } from "../http";
import { authenticateRequest } from "../accounts/auth";
import { objectsClient } from "../objects";
import { finishTiming, runTimed, startTiming } from "../timing";
import { cleanPath, matchesEtag, rawResponse, requestBudget, resolveCommit, Walker } from "./files";
import { monorepoRef, repoNameFor } from "./names";
import { cachedRepo, monorepoStub } from "./session";

export const RAW_RE = /^\/([^/]+)\/([^/]+)\/(?:projects\/([^/]+)\/)?raw\/(.+)$/;

export async function handleRaw(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const m = url.pathname.match(RAW_RE)!;
  const t = startTiming("api", { method: request.method, path: url.pathname, route: "raw", monorepo: `${m[1]}/${m[2]}`.toLowerCase(), repo: m[3] ?? null });

  const res = await runTimed(t, async () => {
    try {
      return await raw(request, env, ctx, url, m);
    } catch (err) {
      return toErrorResponse(err);
    }
  });

  finishTiming(t, { status: res.status });

  return res;
}

async function raw(request: Request, env: Env, ctx: ExecutionContext, url: URL, m: RegExpMatchArray): Promise<Response> {
  const ref = monorepoRef(m[1], m[2]);

  if (!ref) throw new HttpError(404, "not_found", "no such monorepo");
  const auth = await authenticateRequest(env, request, ref);

  if (!auth) throw new HttpError(401, "unauthorized", "unknown, expired or revoked credential");

  if (!auth.monorepo) throw new HttpError(404, "not_found", `no monorepo ${ref.owner}/${ref.name}`);

  if (!auth.role) throw new HttpError(403, "not_a_member", `${auth.user.login} is not a member of ${auth.monorepo.full_name}`);
  const info = auth.monorepo;
  // The web app's address names the project's folder; its repo is named by the one rule (repoNameFor: projects/web is projects-web).
  const project = m[3] ?? null;
  const repoName = project === null ? null : repoNameFor(info.name, `projects/${project}`);

  if (project !== null && repoName === null) throw new HttpError(404, "not_found", `no project ${project}`);

  if (info.kind === "monorepo" && !repoName) return metaRaw(request, env, url, info.id, m[4]);

  if (info.kind === "repo" && repoName) throw new HttpError(404, "not_found", `${info.full_name} is a plain repo: /${info.full_name}/raw/<path>`);
  const rec = await cachedRepo(env, info.id, repoName);

  if (!rec) throw new HttpError(404, "not_found", `no repo ${repoName}`);
  const path = cleanPath(decodeURIComponent(m[4]));

  if (!path) throw new HttpError(404, "not_found", "a file path is needed");
  const obj = objectsClient();
  const w = new Walker(obj, rec, requestBudget(env));
  const stub = monorepoStub(env, info.id);
  const { commit, pinned } = await resolveCommit(env, w, (r) => stub.refHead(rec.name, r), url.searchParams.get("ref"), (sha) => stub.rememberHead(rec.name, sha));
  const entry = await w.entryAt(commit.treeHash, path);

  if (!entry) throw new HttpError(404, "not_found", `no ${path} at this ref`);

  if (entry.type === "tree") throw new HttpError(404, "not_a_file", `${path} is a folder`);

  if (entry.type === "gitlink") throw new HttpError(404, "not_a_file", `${path} is a submodule`);
  const etag = `"${entry.oid}"`;

  if (matchesEtag(request.headers.get("if-none-match"), entry.oid)) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": pinned ? "private, max-age=31536000, immutable" : "private, no-cache" } });
  }

  const blob = await obj.raw(`/blob/${rec.artifacts_name}/${entry.oid}`);

  if (!blob) throw new HttpError(404, "not_found", `${path} could not be read`);

  return rawResponse(blob, path.slice(path.lastIndexOf("/") + 1), entry.oid, pinned, request.method === "HEAD");
}

/**
 * A monorepo's own file, from the meta layer: as it is now (revalidated by
 * ETag), or at ?v=<version> (the file as of that version; never changes, so
 * cached a year). The ETag is the content's sha: git's blob sha, or a large
 * file's SHA-256, whose bytes come from R2.
 */
async function metaRaw(request: Request, env: Env, url: URL, monorepoId: string, rawPath: string): Promise<Response> {
  const path = cleanPath(decodeURIComponent(rawPath));

  if (!path) throw new HttpError(404, "not_found", "a file path is needed");
  const v = url.searchParams.get("v");

  if (v !== null && !/^[1-9][0-9]{0,15}$/.test(v)) throw new HttpError(400, "invalid_input", "v is a meta layer version: a whole number from 1");
  const pinned = v !== null;
  const f = await env.META.get(env.META.idFromName(monorepoId)).readFile(path, pinned ? Number(v) : null);

  if (!f) throw new HttpError(404, "not_found", pinned ? `no ${path} at version ${v}` : `no ${path}`);
  const oid = f.large?.oid ?? f.sha;

  if (matchesEtag(request.headers.get("if-none-match"), oid)) {
    return new Response(null, { status: 304, headers: { etag: `"${oid}"`, "cache-control": pinned ? "private, max-age=31536000, immutable" : "private, no-cache" } });
  }

  let body: Response;

  if (f.large) {
    const obj = await env.BLOBS.get(blobKey(monorepoId, f.large.oid));

    if (!obj) throw new HttpError(404, "not_found", `${path} is a large file whose bytes were never uploaded`);
    body = new Response(obj.body);
  } else {
    body = new Response(f.bytes);
  }

  return rawResponse(body, path.slice(path.lastIndexOf("/") + 1), oid, pinned, request.method === "HEAD");
}
