// The person's live socket (listActivity with Upgrade): each frame patches
// TanStack Query's cache, so the home and the monorepo pages move without a
// reload. It reconnects with backoff, resumes from the last `landed` number,
// and refetches what it may have missed.
import type { FeedEvent, MonorepoId, MonorepoSummary } from "@pando/contract";
import type { QueryClient } from "@tanstack/react-query";
import { decodeFrame } from "../api/client";
import { applyLine } from "./lines";

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

const PING_MS = 30_000;

const byActivity = (a: MonorepoSummary, b: MonorepoSummary) =>
  (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? "") || a.full_name.localeCompare(b.full_name);

function patchLine(qc: QueryClient, id: MonorepoId, patch: Partial<MonorepoSummary>) {
  qc.setQueryData<readonly MonorepoSummary[]>(["monorepos"], (list) => list?.map((m) => (m.id === id ? { ...m, ...patch } : m)).sort(byActivity));
}

function onEvent(qc: QueryClient, e: FeedEvent) {
  applyLine(qc, e);
  patchLine(qc, e.monorepo_id, { last_activity_at: e.at });
}

export function startFeed(qc: QueryClient): () => void {
  let socket: WebSocket | null = null;
  let landed: number | null = null;
  let attempt = 0;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;

  const refetchAll = () => {
    for (const key of [["activity"], ["monorepos"], ["needs"]]) void qc.invalidateQueries({ queryKey: key });
  };

  const connect = () => {
    const resuming = landed !== null;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/events`);
    socket = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify(resuming ? { type: "hello", since: landed } : { type: "hello" }));
      ping = setInterval(() => ws.send("ping"), PING_MS);
    };

    ws.onmessage = (msg) => {
      const f = decodeFrame(String(msg.data));

      if (!f) return;

      switch (f.type) {
        case "event":
          landed = Math.max(landed ?? 0, f.landed);
          onEvent(qc, f.event);
          break;
        case "caught_up":
          // A fresh hello replays nothing: lines from before it come from a refetch.
          if (!resuming || attempt > 0) refetchAll();
          landed = Math.max(landed ?? 0, f.landed);
          attempt = 0;
          break;
        case "resync":
          landed = f.landed;
          refetchAll();
          break;
        case "summary":
          patchLine(qc, f.monorepo_id, f.summary);
          break;
        case "needs":
          void qc.invalidateQueries({ queryKey: ["needs"] });
          break;
        case "joined":
        case "left":
          refetchAll();
          break;
        case "error":
          break;
      }
    };

    ws.onclose = () => {
      clearInterval(ping);

      if (stopped) return;
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
