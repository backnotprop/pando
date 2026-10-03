// The meta layer's routes, for worker/src/index.ts to call (see meta-sync.md):
//
//   GET  /v1/monorepos/{monorepo}/meta/socket    WebSocket
//   GET  /v1/monorepos/{monorepo}/meta/history
//   GET  /v1/monorepos/{monorepo}/meta/file
//   POST /v1/monorepos/{monorepo}/meta/restore
//   GET  /v1/monorepos/{monorepo}/meta/status
//
// The Worker checks the token first, then passes who it is as `identity`.
// Until then the object takes the author from the client's hello.
import type { MetaLayerObject } from "./object";

export interface LiveEnv {
  META: DurableObjectNamespace<MetaLayerObject>;
}

export interface MetaIdentity {
  name: string;
  email?: string;
  role: "person" | "agent";
}

const ROUTE = /^\/v1\/monorepos\/([^/]+)\/meta\/(socket|history|file|restore|status)$/;
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._]|-(?!-)){0,62}$/; // Pando names forbid "--"

// metaRoute returns the monorepo name when the request is a meta layer route.
export function metaRoute(request: Request): string | null {
  const m = new URL(request.url).pathname.match(ROUTE);
  if (!m) return null;
  const name = decodeURIComponent(m[1]);
  return NAME.test(name) ? name : null;
}

// routeMeta forwards a meta layer request to the monorepo's object, or returns
// null when the request is not one.
export async function routeMeta(request: Request, env: LiveEnv, identity?: MetaIdentity): Promise<Response | null> {
  const monorepo = metaRoute(request);
  if (!monorepo) return null;
  const headers = new Headers(request.headers);
  for (const h of ["x-pando-author", "x-pando-agent", "x-pando-monorepo", "x-pando-meta-repo"]) headers.delete(h);
  headers.set("x-pando-monorepo", monorepo);
  headers.set("x-pando-meta-repo", `${monorepo}--meta`); // api-v1.yaml: the meta layer's Artifacts repo
  if (identity) {
    headers.set("x-pando-author", identity.email ? `${identity.name} <${identity.email}>` : identity.name);
    if (identity.role === "agent") headers.set("x-pando-agent", identity.name);
  }
  const stub = env.META.get(env.META.idFromName(monorepo));
  return stub.fetch(new Request(request, { headers }));
}
