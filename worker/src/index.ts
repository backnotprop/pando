// The Pando Worker: the one way in. Routes are owned by lanes (see
// docs/contracts/README.md); this file only wires them together.
//   /healthz                       up check (readable from any origin: the docs' Status page); which commit runs
//   /docs, /docs/<path>            302 to the docs site (wrangler.jsonc DOCS_URL)
//   /install, /install.sh          the one-line install's script (install.ts)
//   /v1/openapi.yaml               the contract (docs/contracts/api-v1.yaml)
//   /<owner>/<monorepo>/<repo>.git, /<owner>/<repo>.git   the git door (server-git)
//   /v1/users, /v1/login/...       sign-in (accounts/signin.ts)
//   /v1/monorepos/{o}/{m}/meta/... the meta layer (live; wired at M3)
//   /v1/integrations/buildkite/... CI services' webhooks (ci/routes.ts)
//   /v1/...                        the API (server-git)
//   /mcp                           the MCP endpoint (mcp/handler.ts)
//   /.well-known/oauth-*, /oauth/* its sign-in: Pando's own OAuth authorization server (mcp/oauth.ts)
//   any other GET                  the web app (web/, wrangler.jsonc assets)
import contract from "../../docs/contracts/api-v1.yaml";
import type { Env } from "./env";
import { errorJson, HttpError, toErrorResponse } from "./http";
import { authenticateRequest } from "./accounts/auth";
import { finishTiming, note, runTimed, startTiming } from "./timing";
import { metaRoute, metaTestRoute, routeMeta } from "./live/route";
import { api } from "./monorepo/api";
import { doorTestRoute, handleDoor, isDoorPath, type IncomingRequest } from "./monorepo/door";
import { handleRaw, RAW_RE } from "./monorepo/raw";
import { handleHistoryBatch, type HistoryMessage } from "./monorepo/files";
import { objectsClient } from "./objects";
import { monorepoStub } from "./monorepo/session";
import { signin } from "./accounts/signin";
import { factsTestRoute } from "./monorepo/facts";
import { checksTestRoute } from "./monorepo/checks";
import { riskScoreRoute, riskTestRoute } from "./review/test-route";
import { hooksTestRoute } from "./monorepo/hooks";
import { handleFeedBatch } from "./feed/consumer";
import { handleFeed, isFeedPath } from "./feed/routes";
import type { FeedMessage } from "./feed/shape";
import { handleIntegration, isIntegrationPath } from "./ci/routes";
import { githubCallback } from "./mirror/routes";
import { install, isInstallPath } from "./install";
import { mirrorTestRoute } from "./mirror/test-route";
import { handleMcp } from "./mcp/handler";
import { handleOAuth, isOAuthPath } from "./mcp/oauth";

export { MonorepoObject } from "./monorepo/object";

export { Objects } from "./objects";

export { AccountsObject } from "./accounts/object";

export { MetaLayerObject } from "./live/object";

export { FeedObject } from "./feed/object";

export { FeedDrain } from "./feed/consumer";

export { FactsDrain } from "./monorepo/facts";

export { HooksDrain } from "./monorepo/hooks";

export { MirrorDrain } from "./mirror/run";

export { AgentReports } from "./agents/reports";

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

    return (await routeMeta(request, env, auth.monorepo.id, { name: user.name ?? user.login, email: user.email ?? undefined, login: user.login }))!;
  } catch (err) {
    return toErrorResponse(err);
  }
}

// ── The web app (web/, served from wrangler.jsonc `assets`) ──────────────────

/** Headers on the app's pages (APPROACH.md, "Where it lives"). connect-src adds the docs site, where the home reads What's new. */
const appCsp = (env: Env) =>
  `default-src 'self'; connect-src 'self' ${new URL(env.DOCS_URL).origin}; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:`;

/** The docs site (decisions/RULINGS.md: docs.<domain>, the app's /docs redirecting there): /docs/<path>?<query> to the same path there. */
function docs(env: Env, url: URL): Response {
  const rest = url.pathname.slice("/docs".length).replace(/^\//, "");

  // Appended to the base's own path, so the redirect never leaves the docs site.
  return Response.redirect(`${env.DOCS_URL.replace(/\/$/, "")}/${rest}${url.search}`, 302);
}

/** A page of the app: any GET or HEAD outside /v1 that no route above took. */
function isAppPath(request: Request, url: URL): boolean {
  return (request.method === "GET" || request.method === "HEAD") && !url.pathname.startsWith("/v1/");
}

/** The app's file for this path, or index.html (the app's router takes the path), with its headers on HTML. */
async function app(request: Request, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(request);

  if (!(res.headers.get("content-type") ?? "").startsWith("text/html")) return res;

  const page = new Response(res.body, res);

  page.headers.set("content-security-policy", appCsp(env));
  page.headers.set("x-content-type-options", "nosniff");
  page.headers.set("referrer-policy", "same-origin");

  return page;
}

const worker = {
  /** The queues: last commits (monorepo/files.ts) and the feed. */
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    if (batch.queue === "pando-history") {
      // SAFETY: only this Worker sends to pando-history (HISTORY_QUEUE.send in
      // monorepo/files.ts, typed HistoryMessage), and this batch is that queue's.
      return handleHistoryBatch(batch as MessageBatch<HistoryMessage>, env, ctx, {
        objects: objectsClient,
        mergesFor: (id, repo) => (shas) => monorepoStub(env, id).mergedBranches(repo, shas),
      });
    }

    if (batch.queue === "pando-feed") {
      // SAFETY: only this Worker sends to pando-feed (FEED_QUEUE.sendBatch in
      // feed/, typed FeedMessage), and this batch is that queue's.
      return handleFeedBatch(batch as MessageBatch<FeedMessage>, env);
    }

    console.error(`a batch from an unknown queue ${batch.queue}; acked`);
    batch.ackAll();
  },

  async fetch(request: IncomingRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") return healthz(request, env);

    if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/docs" || url.pathname.startsWith("/docs/"))) return docs(env, url);

    if ((request.method === "GET" || request.method === "HEAD") && isInstallPath(url.pathname)) return install(request);

    if (url.pathname === "/v1/openapi.yaml") return new Response(contract, { headers: { "content-type": "application/yaml; charset=utf-8" } });

    if (isDoorPath(url.pathname)) return handleDoor(request, env, ctx);

    if ((request.method === "GET" || request.method === "HEAD") && RAW_RE.test(url.pathname)) return handleRaw(request, env, ctx);

    // A guard for FILES.md: this entrypoint is never cached, even when an answer says it may be.
    if (url.pathname === "/v1/_probe/uncached") {
      return new Response(JSON.stringify({ id: crypto.randomUUID() }), { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } });
    }

    if (url.pathname === "/v1/users" || url.pathname === "/v1/logout" || url.pathname.startsWith("/v1/login/")) return signin.fetch(request, env, ctx);

    if (META_RE.test(url.pathname)) return meta(request, env);

    if (isFeedPath(url.pathname)) return handleFeed(request, env);

    if (url.pathname === "/v1/_facts/test") return factsTestRoute(request, env);

    if (url.pathname === "/v1/_hooks/test") return hooksTestRoute(request, env);

    if (url.pathname === "/v1/_door/test") return doorTestRoute(request, env);

    if (url.pathname === "/v1/_meta/test") return metaTestRoute(request, env);

    if (url.pathname === "/v1/_checks/test") return checksTestRoute(request, env);

    if (url.pathname === "/v1/_risk/test") return riskTestRoute(request, env);

    if (url.pathname === "/v1/_risk/score") return riskScoreRoute(request, env);

    if (url.pathname === "/v1/_mirror/test") return mirrorTestRoute(request, env);

    if (url.pathname === "/v1/github/callback" && request.method === "GET") return githubCallback(request, env);

    if (url.pathname === "/mcp") {
      // SAFETY: the tools' own requests to the API, made in this isolate; they carry no cf properties, which every route reads as optional.
      return handleMcp(request, env, (r) => worker.fetch(r as IncomingRequest, env, ctx));
    }

    if (isOAuthPath(url.pathname)) return handleOAuth(request, env);

    if (isIntegrationPath(url.pathname)) return handleIntegration(request, env);

    if (isAppPath(request, url)) return app(request, env);

    return api.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env, unknown>;

export default worker;

/**
 * The up check: "ok", read by the docs' Status page from any origin. It also says which commit runs: the Worker
 * version's tag, which deploy.sh sets to the commit (`wrangler deploy --tag <sha>`), as X-Pando-Commit, and as
 * JSON when asked for it ({ok, commit, version, deployed_at}). A version deployed without a commit tag answers null.
 */
function healthz(request: Request, env: Env): Response {
  const v = env.VERSION;
  const commit = v && /^[0-9a-f]{40}$/.test(v.tag) ? v.tag : null;
  const headers = new Headers({ "access-control-allow-origin": "*", "access-control-expose-headers": "x-pando-commit", "cache-control": "no-store" });

  if (commit) headers.set("x-pando-commit", commit);

  if ((request.headers.get("accept") ?? "").includes("application/json")) {
    return Response.json({ ok: true, commit, version: v?.id || null, deployed_at: v?.timestamp || null }, { headers });
  }

  return new Response("ok\n", { headers });
}
