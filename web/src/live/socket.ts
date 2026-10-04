// One socket on Pando's own origin, kept open: it reconnects with backoff
// (1 s up to 30 s, jittered), from the path `path()` gives at each try (so a
// reconnect can resume), and pings every 30 s. A 4404 close (the monorepo was
// deleted) ends it.
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

const PING_MS = 30_000;

export interface SocketHandlers {
  frame: (data: string) => void;
  /** It opened (`true`), or closed and is about to try again (`false`). */
  up?: (open: boolean) => void;
}

/** Opens the socket and keeps it open; returns the function that closes it for good. */
export function keepOpen(path: () => string, on: SocketHandlers): () => void {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;

  const connect = () => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path()}`);

    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      ping = setInterval(() => ws.send("ping"), PING_MS);
      on.up?.(true);
    };

    ws.onmessage = (msg) => on.frame(String(msg.data));
    ws.onclose = (e) => {
      clearInterval(ping);

      if (stopped || e.code === 4404) return;
      on.up?.(false);
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000;

      attempt += 1;
      retry = setTimeout(connect, wait * (0.8 + Math.random() * 0.4));
    };
  };

  connect();

  return () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(ping);
    socket?.close();
  };
}
