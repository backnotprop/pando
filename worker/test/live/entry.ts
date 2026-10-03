// A Worker with only the meta layer routes, for testing the live lane with
// `wrangler dev` before it is wired into src/index.ts. Never deployed.
import { routeMeta, type LiveEnv } from "../../src/live/route";
export { MetaLayerObject } from "../../src/live/object";

export default {
  async fetch(request: Request, env: LiveEnv): Promise<Response> {
    if (new URL(request.url).pathname === "/healthz") return new Response("ok\n");
    return (await routeMeta(request, env)) ?? new Response("not found\n", { status: 404 });
  },
} satisfies ExportedHandler<LiveEnv>;
