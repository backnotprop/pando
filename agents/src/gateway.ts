// Outbound HTTP from a session's container to http://pando.internal lands
// here, outside the container. The gateway adds the session's credential and
// forwards to Pando's Worker over the service binding, for this one
// repository and only what pando and git need inside the sandbox:
//
//   git smart HTTP          /<owner>/<name>.git/... and /<owner>/<name>/<repo>.git/...
//   GET, HEAD               /v1/monorepos/<owner>/<name>[/...]   (pando clone, worktree add, reads)
//   POST                    .../repos/<repo>/branches             (pando worktree add makes the branch)
//   PUT                     .../worktrees/<id>                    (pando reports its worktree)
//   PUT                     .../meta/blobs/<sha256>               (pando sync sends a large shared file)
//
// pando sync's socket (GET .../meta/socket) and the follower's event socket
// are GETs: the shared files go both ways over the socket.
//
// Everything else is refused with 403, merges included: an agent merges
// through its merge tool in the session object, never from the sandbox.
// The URL keeps its http://pando.internal origin, so the clone URLs Pando
// answers with point back through here.

import { WorkerEntrypoint } from "cloudflare:workers";
import { INTERNAL_HOST } from "./sandbox";

export interface GatewayProps {
  /** owner/name */
  monorepo: string;
  /** The session's Authorization header value. */
  authorization: string;
}

interface GatewayEnv {
  PANDO: Fetcher;
}

const GIT_SERVICE = /\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Whether the gateway lets this request through for this repository. */
export function allowed(method: string, url: URL, monorepo: string): boolean {
  if (url.hostname !== INTERNAL_HOST) return false;
  const path = url.pathname;

  if (GIT_SERVICE.test(path)) {
    return path.startsWith(`/${monorepo}.git/`) || path.startsWith(`/${monorepo}/`);
  }

  const api = `/v1/monorepos/${monorepo}`;

  if (path !== api && !path.startsWith(`${api}/`)) return false;
  const tail = path.slice(api.length);

  switch (method) {
    case "GET":
    case "HEAD":
      return true;
    case "POST":
      return /^\/repos\/[^/]+\/branches$/.test(tail);
    case "PUT":
      return /^\/worktrees\/[^/]+$/.test(tail) || /^\/meta\/blobs\/[0-9a-f]{64}$/.test(tail);
    default:
      return false;
  }
}

export class Gateway extends WorkerEntrypoint<GatewayEnv, GatewayProps> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { monorepo, authorization } = this.ctx.props;

    if (!allowed(request.method, url, monorepo)) {
      return new Response("refused by the session gateway\n", { status: 403 });
    }

    const headers = new Headers(request.headers);
    headers.set("Authorization", authorization);

    // SAFETY: duplex is a RequestInit field the Workers types do not list yet; a streamed body needs it.
    const init = { method: request.method, headers, body: request.body, duplex: "half" } as RequestInit;

    return this.env.PANDO.fetch(new Request(url, init));
  }
}
