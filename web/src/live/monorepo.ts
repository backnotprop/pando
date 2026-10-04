// One monorepo's own socket (its event stream with topics=feed), open while a
// page of that monorepo is: its activity lines, numbered `n`. A monorepo of
// over 100 members sends none to the person's socket, so its pages need this;
// for the others it brings branch and check changes to the page at once. It
// reconnects with backoff and asks for what it missed (feed_since); past 500
// missed lines the server says feed_resync, and the log is refetched.
import { Routes } from "@pando/contract";
import type { QueryClient } from "@tanstack/react-query";
import { decodeMonorepoFrame } from "../api/client";
import type { MonorepoRef } from "../api/names";
import { applyLine } from "./lines";

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

const PING_MS = 30_000;

export function startMonorepoFeed(qc: QueryClient, m: MonorepoRef): () => void {
  let socket: WebSocket | null = null;
  let lastN: number | null = null;
  let attempt = 0;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;

  const refetch = () => void qc.invalidateQueries({ queryKey: ["activity", m.full] });

  const connect = () => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${Routes.monorepoFeedSocketPath(m.owner, m.name, lastN)}`);

    socket = ws;
    ws.onopen = () => {
      ping = setInterval(() => ws.send("ping"), PING_MS);
    };

    ws.onmessage = (msg) => {
      const f = decodeMonorepoFrame(String(msg.data));

      if (!f) return;

      switch (f.type) {
        case "feed":
          lastN = Math.max(lastN ?? 0, f.n);
          applyLine(qc, f.event);
          break;
        case "caught_up":
          lastN = f.feed_n ?? lastN;
          attempt = 0;
          break;
        case "feed_resync":
          lastN = f.feed_n;
          refetch();
          break;
        case "resync":
          refetch();
          break;
        case "error":
          break;
      }
    };

    ws.onclose = (e) => {
      clearInterval(ping);

      // 4404: the monorepo was deleted.
      if (stopped || e.code === 4404) return;

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
