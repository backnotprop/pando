// The Pando Worker: the one way in. Routes are owned by lanes (see
// docs/contracts/README.md); this file only wires them together.
//   /healthz                       up check
//   /v1/openapi.yaml               the contract (docs/contracts/api-v1.yaml)
//   /<owner>/<monorepo>/<repo>.git, /<owner>/<repo>.git   the git door (server-git)
//   /v1/users, /v1/login/...       sign-in (accounts/signin.ts)
//   /v1/monorepos/{o}/{m}/meta/... the meta layer (live; wired at M3)
//   /v1/integrations/buildkite/... CI services' webhooks (ci/routes.ts)
//   /v1/...                        the API (server-git)
import contract from "../../docs/contracts/api-v1.yaml";
import type { Env } from "./env";
import { errorJson, HttpError, toErrorResponse } from "./http";
import { authenticateRequest } from "./accounts/auth";
import { finishTiming, note, runTimed, startTiming } from "./timing";
import { metaRoute, routeMeta } from "./live/route";
import { api } from "./monorepo/api";
import { handleDoor, isDoorPath } from "./monorepo/door";
import { signin } from "./accounts/signin";
import { handleFactsBatch, type FactsMessage } from "./monorepo/facts";
import { handleDeadDeliveries, handleDeliveries, type DeliveryMessage } from "./monorepo/hooks";
import { handleFeedBatch } from "./feed/consumer";
import { handleFeed, isFeedPath } from "./feed/routes";
import type { FeedMessage } from "./feed/shape";
import { handleIntegration, isIntegrationPath } from "./ci/routes";

export { MonorepoObject } from "./monorepo/object";
export { AccountsObject } from "./accounts/object";
export { MetaLayerObject } from "./live/object";
export { FeedObject } from "./feed/object";
export type { Env };

const META_RE = /^\/v1\/monorepos\/[^/]+\/[^/]+\/meta(\/|$)/;

/** The meta layer (live lane): members only, `init` for owners; the object gets the user as the author. */
async function meta(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  const seg = path.split("/");
  const t = startTiming("api", { method: request.method, path, monorepo: `${seg[3]}/${seg[4]}`.toLowerCase(), repo: "meta" });
  const res = await runTimed(t, () => metaInner(request, env));
  finishTiming(t, { status: res.status });
  return res;
}

async function metaInner(request: Request, env: Env): Promise<Response> {
  try {
    const m = metaRoute(request);
    if (!m) return errorJson(404, "not_found", "no such meta layer route");
    const auth = await authenticateRequest(env, request, m);
    if (!auth) throw new HttpError(401, "unauthorized", "unknown or revoked credential");
    if (!auth.monorepo) throw new HttpError(404, "not_found", `no monorepo ${m.owner}/${m.name}`);
    const full = auth.monorepo.full_name;
    note({ monorepo: full, monorepo_id: auth.monorepo.id });
    if (!auth.role) throw new HttpError(403, "not_a_member", `${auth.user.login} is not a member of ${full}`);
    if (auth.monorepo.kind !== "monorepo") throw new HttpError(404, "no_meta_layer", `${full} is a plain git repo; it has no meta layer`);
    if (new URL(request.url).pathname.endsWith("/meta/init") && auth.role !== "owner") {
      throw new HttpError(403, "owner_only", "only an owner can make the meta layer's first upload");
    }
    const user = auth.user;
    return (await routeMeta(request, env, auth.monorepo.id, { name: user.name ?? user.login, email: user.email ?? undefined }))!;
  } catch (err) {
    return toErrorResponse(err);
  }
}

export default {
  /** The queues: branch facts (monorepo/facts.ts), hook deliveries and their dead letters (monorepo/hooks.ts). */
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue === "pando-hooks") return handleDeliveries(batch as MessageBatch<DeliveryMessage>, env);
    if (batch.queue === "pando-hooks-dlq") return handleDeadDeliveries(batch as MessageBatch<DeliveryMessage>, env);
    if (batch.queue === "pando-feed") return handleFeedBatch(batch as MessageBatch<FeedMessage>, env);
    return handleFactsBatch(batch as MessageBatch<FactsMessage>, env);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok\n");
    if (url.pathname === "/v1/openapi.yaml") return new Response(contract, { headers: { "content-type": "application/yaml; charset=utf-8" } });
    if (isDoorPath(url.pathname)) return handleDoor(request, env, ctx);
    if (url.pathname === "/v1/users" || url.pathname === "/v1/logout" || url.pathname.startsWith("/v1/login/")) return signin.fetch(request, env, ctx);
    if (META_RE.test(url.pathname)) return meta(request, env);
    if (isFeedPath(url.pathname)) return handleFeed(request, env);
    if (isIntegrationPath(url.pathname)) return handleIntegration(request, env);
    return api.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env, unknown>;
