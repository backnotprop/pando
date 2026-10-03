// The Pando Worker: the one way in. Routes are owned by lanes (see
// docs/contracts/README.md); this file only wires them together.
export { MonorepoObject } from "./monorepo/object";
export { MetaLayerObject } from "./live/object";

export interface Env {
  MONOREPO: DurableObjectNamespace;
  META: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok\n");
    return new Response("not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
