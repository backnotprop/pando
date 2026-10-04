// Closing a person's hibernating sockets when their access to a monorepo ends
// (monorepo/access.ts asks each object). The monorepo object's event sockets
// and the meta object's live sockets both keep the login on each socket's
// attachment, and are found by it. Not by a hibernation tag: an event socket
// has at most 10 tags, all of them topics (the follower asks for up to 10).
//
// The close frame goes out at once. Measured on wrangler dev (2026-10-04):
// for a socket whose client never sent a frame, the runtime ends the
// connection only when the object next goes idle (10 to 15 s), so a client
// that waits for that (Node's WebSocket) hears of the close late. A client
// that has sent anything, a "ping" included, is let go at once: the web sends
// one as each socket opens; pando's sockets say hello.

/**
 * WebSocket close code: the person no longer has access to the monorepo.
 * Clients stop reconnecting and say so (4404 is "the monorepo was deleted").
 */
export const NO_ACCESS = 4403;

/** Close this object's sockets of these logins; returns how many it closed. */
export function closeLogins(ctx: DurableObjectState, logins: string[], loginOf: (ws: WebSocket) => string | null | undefined): number {
  const lost = new Set(logins);
  let closed = 0;

  for (const ws of ctx.getWebSockets()) {
    const login = loginOf(ws);

    if (!login || !lost.has(login)) continue;

    try {
      ws.close(NO_ACCESS, "you no longer have access to this monorepo");
      closed++;
    } catch {
      // already closed
    }
  }

  return closed;
}
