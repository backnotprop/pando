// The meta layer's routes, for worker/src/index.ts to call (see meta-sync.md):
//
//   GET  /v1/monorepos/{owner}/{monorepo}/meta/socket    WebSocket
//   GET  /v1/monorepos/{owner}/{monorepo}/meta/history
//   GET  /v1/monorepos/{owner}/{monorepo}/meta/file
//   POST /v1/monorepos/{owner}/{monorepo}/meta/restore
//   GET  /v1/monorepos/{owner}/{monorepo}/meta/status    (with connections: who is connected now)
//   GET  /v1/monorepos/{owner}/{monorepo}/meta/tree      every current path, ?prefix= to narrow
//   GET  /v1/monorepos/{owner}/{monorepo}/meta/references   the reference pointers, parsed
//   POST /v1/monorepos/{owner}/{monorepo}/meta/init      pando init's first upload
//   PUT, GET, HEAD /v1/monorepos/{owner}/{monorepo}/meta/blobs/{sha256}   large files (blobs.ts)
//
// The Worker checks the credential first, then passes the user as `identity`.
// Without one the object takes the author from the client's hello.
import { monorepoRef } from "../monorepo/names";
import type { Env } from "../env";
import { isRecord, isText, isWholeNumber, type Json } from "../parse";
import { handleBlob } from "./blobs";
import type { MetaLayerObject, MetaOutboxTest } from "./object";

export interface LiveEnv {
  META: DurableObjectNamespace<MetaLayerObject>;
  BLOBS?: R2Bucket; // pando-dev-blobs
}

// The user behind the credential (api-v1.yaml: agents act as their user).
export interface MetaIdentity {
  name: string;
  email?: string;
  login?: string;
}

const ROUTE = /^\/v1\/monorepos\/([^/]+)\/([^/]+)\/meta\/(socket|history|file|restore|status|init|tree|references|blobs\/[^/]+)$/;

// metaRoute returns the path's owner and monorepo name (lower case) when the request is a meta layer route.
export function metaRoute(request: Request): { owner: string; name: string } | null {
  const m = new URL(request.url).pathname.match(ROUTE);

  if (!m) return null;

  return monorepoRef(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
}

function blobOid(request: Request): string | null {
  const m = new URL(request.url).pathname.match(/\/meta\/blobs\/([^/]+)$/);

  return m ? m[1] : null;
}

// routeMeta forwards a meta layer request to the object of the monorepo with
// this id (the Worker resolved the path's owner/name), or returns null when
// the request is not one. The id keys the object, R2 and the Artifacts repo.
export async function routeMeta(request: Request, env: LiveEnv, monorepo: string, identity?: MetaIdentity): Promise<Response | null> {
  if (!metaRoute(request)) return null;
  const oid = blobOid(request);

  if (oid !== null) return handleBlob(request, env.BLOBS, monorepo, oid);
  const headers = new Headers(request.headers);

  for (const h of ["x-pando-author", "x-pando-login", "x-pando-monorepo", "x-pando-meta-repo"]) headers.delete(h);
  headers.set("x-pando-monorepo", monorepo);
  headers.set("x-pando-meta-repo", `${monorepo}--meta`); // api-v1.yaml: the meta layer's Artifacts repo

  if (identity) {
    headers.set("x-pando-author", identity.email ? `${identity.name} <${identity.email}>` : identity.name);

    if (identity.login) headers.set("x-pando-login", identity.login);
  }

  const stub = env.META.get(env.META.idFromName(monorepo));

  return stub.fetch(new Request(request, { headers }));
}

/**
 * Tests only (META_TEST=1 and the bootstrap secret): POST /v1/_meta/test
 * {monorepo, fail?, lose?, crash?, apply_fail?, apply_lose?} sets the meta
 * layer object's next event sends to fail, to lose their answer, or to crash
 * the object first, and its next updates from main to fail, or to apply and
 * lose their answer; GET ?monorepo= shows its outbox. The monorepo is its id.
 */
export async function metaTestRoute(request: Request, env: Env): Promise<Response> {
  if (env.META_TEST !== "1") return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
  const { credential } = await import("../http");
  const { isBootstrap } = await import("../monorepo/session");

  if (!(await isBootstrap(env, credential(request)))) return Response.json({ error: { code: "unauthorized", message: "the bootstrap secret only" } }, { status: 401 });
  const b = request.method === "POST" ? await request.json<Json>().catch(() => null) : null;
  const id = (isRecord(b) && isText(b.monorepo) ? b.monorepo : null) ?? new URL(request.url).searchParams.get("monorepo");

  if (!id) return Response.json({ error: { code: "bad_request", message: "monorepo (its id)" } }, { status: 400 });
  const set: Partial<MetaOutboxTest> = {};

  if (isRecord(b) && isWholeNumber(b.fail)) set.fail = b.fail;

  if (isRecord(b) && isWholeNumber(b.lose)) set.lose = b.lose;

  if (isRecord(b) && (b.crash === true || b.crash === false)) set.crash = b.crash;

  if (isRecord(b) && isWholeNumber(b.apply_fail)) set.applyFail = b.apply_fail;

  if (isRecord(b) && isWholeNumber(b.apply_lose)) set.applyLose = b.apply_lose;

  return Response.json(await env.META.get(env.META.idFromName(id)).testOutbox(set));
}
