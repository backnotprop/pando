// The Pando Worker: the one way in. Routes are owned by lanes (see
// docs/contracts/README.md); this file only wires them together.
//   /healthz                       up check
//   /v1/openapi.yaml               the contract (docs/contracts/api-v1.yaml)
//   /<monorepo>/<repo>.git/...     the git door (server-git)
//   /v1/monorepos/{m}/meta/...     the meta layer (live; wired at M3)
//   /v1/...                        the API (server-git)
import contract from "../../docs/contracts/api-v1.yaml";
import type { Env } from "./env";
import { errorJson } from "./http";
import { api } from "./monorepo/api";
import { handleDoor, isDoorPath } from "./monorepo/door";

export { MonorepoObject } from "./monorepo/object";
export { MetaLayerObject } from "./live/object";
export type { Env };

const META_RE = /^\/v1\/monorepos\/[^/]+\/meta(\/|$)/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok\n");
    if (url.pathname === "/v1/openapi.yaml") return new Response(contract, { headers: { "content-type": "application/yaml; charset=utf-8" } });
    if (isDoorPath(url.pathname)) return handleDoor(request, env, ctx);
    if (META_RE.test(url.pathname)) return errorJson(501, "not_wired", "the meta layer routes arrive with the live lane (M3)");
    return api.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
