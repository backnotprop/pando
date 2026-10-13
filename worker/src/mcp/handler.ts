// The MCP endpoint: POST /mcp, Streamable HTTP, stateless, JSON answers only (no SSE, no sessions).
// The 2026-07-28 protocol through the SDK's createMcpHandler (strict: legacy "reject"), and the 2025
// revisions (2025-06-18, 2025-11-25) through its stateless transport, for hosts that still speak them;
// each request is classified once and stays in its era. subscriptions/listen is refused (no change
// events yet). GET and DELETE answer 405.
//
// The caller: a Bearer credential of the person, checked before any MCP work. The kind "mcp" from the
// sign-in (oauth.ts) is the normal one; a machine credential (`pando login`) works too, for scripts. A
// missing, unknown or revoked bearer, or a browser cookie alone, gets the same 401 and challenge.
// Tools then call the /v1 API in this isolate as that person (asMcpCall), never over the network.

import { createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport, type AuthInfo } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import { credential } from "../http";
import { isRecord, isText, parseJson } from "../parse";
import { finishTiming, runTimed, startTiming } from "../timing";
import { asMcpCall, authenticate } from "../accounts/auth";
import { mcpOrigin, resourceMetadataUrl, SCOPE } from "./oauth";
import { buildServer, type Caller } from "./tools";

/** The Worker's own fetch, for the tools' calls to the API. */
export type Dispatch = (req: Request) => Promise<Response>;

/** The largest MCP request taken: 1 MiB. */
const MAX_BODY = 1 << 20;

const rpcError = (status: number, code: number, message: string, headers: HeadersInit = {}) =>
  Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status, headers: { "cache-control": "no-store", ...Object.fromEntries(new Headers(headers)) } });

/** The answer to a missing or bad credential: always this one challenge and body, whatever the reason. */
function unauthorized(origin: string): Response {
  return Response.json(
    { error: "invalid_token", error_description: "Sign in to Pando: your MCP host opens the browser for it" },
    {
      status: 401,
      headers: {
        "www-authenticate": `Bearer realm="Pando", resource_metadata="${resourceMetadataUrl(origin)}", scope="${SCOPE}"`,
        "cache-control": "no-store",
      },
    },
  );
}

/** /mcp. */
export async function handleMcp(req: Request, env: Env, dispatch: Dispatch): Promise<Response> {
  const url = new URL(req.url);
  const origin = mcpOrigin(env, url);

  if (!origin) return Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });

  if (req.method !== "POST") return rpcError(405, -32600, "Method not allowed: /mcp takes POST (Streamable HTTP, no sessions)", { allow: "POST" });
  const from = req.headers.get("origin");

  // A page on another site must not reach /mcp through a person's browser (DNS rebinding included).
  if (from !== null && from !== origin) return rpcError(403, -32600, "Forbidden: this Origin may not call /mcp");
  const secret = credential(req);
  const auth = secret ? await authenticate(env, secret, null) : null;

  if (!secret || !auth || auth.credential.kind === "browser") return unauthorized(origin);
  const size = Number(req.headers.get("content-length") ?? "0");

  if (size > MAX_BODY) return rpcError(413, -32600, "The request is over 1 MiB");
  const body = await req.text();

  if (body.length > MAX_BODY) return rpcError(413, -32600, "The request is over 1 MiB");

  const caller: Caller = {
    auth,
    origin,
    async call(method, path, json) {
      const headers = new Headers({ authorization: `Bearer ${secret}`, accept: "application/json" });
      const init: RequestInit = { method, headers };

      if (json !== undefined) {
        const text = JSON.stringify(json);
        // Routes that read a body only when one is announced (merge) look at its length.
        headers.set("content-type", "application/json");
        headers.set("content-length", String(new TextEncoder().encode(text).byteLength));
        init.body = text;
      }

      const res = await dispatch(asMcpCall(new Request(`${origin}${path}`, init)));

      return { status: res.status, text: await res.text(), type: res.headers.get("content-type") ?? "" };
    },
  };

  const forward = () => new Request(req.url, { method: "POST", headers: req.headers, body });
  const authInfo: AuthInfo = { token: secret, clientId: auth.credential.id, scopes: [SCOPE] };
  const legacy = await isLegacyRequest(forward());
  const rpc = parseJson(body);
  const params = isRecord(rpc) && isRecord(rpc.params) ? rpc.params : null;

  // One pando.timing line per MCP request: the method, the protocol the host speaks, and its credential's kind.
  const t = startTiming("mcp", {
    method: "POST",
    path: "/mcp",
    rpc: isRecord(rpc) && isText(rpc.method) ? rpc.method : null,
    tool: params && isText(params.name) ? params.name : null,
    era: legacy ? "2025" : "2026",
    protocol: (params && isText(params.protocolVersion) ? params.protocolVersion : null) ?? req.headers.get("mcp-protocol-version"),
    credential_kind: auth.credential.kind,
  });

  const res = await runTimed(t, () => serve(caller, forward, authInfo, legacy));
  finishTiming(t, { status: res.status });

  return res;
}

async function serve(caller: Caller, forward: () => Request, authInfo: AuthInfo, legacy: boolean): Promise<Response> {
  if (legacy) {
    const server = buildServer(caller);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);

    try {
      return await transport.handleRequest(forward(), { authInfo });
    } finally {
      await server.close();
    }
  }

  const handler = createMcpHandler(() => buildServer(caller), { legacy: "reject", responseMode: "json", maxSubscriptions: 0, maxRequestBodySize: MAX_BODY });

  return handler.fetch(forward(), { authInfo });
}
