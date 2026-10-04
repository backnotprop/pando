// The person's live socket (listActivity with Upgrade): each frame patches
// TanStack Query's cache, so the home and the monorepo pages move without a
// reload. It reconnects with backoff, resumes from the last `landed` number,
// and refetches what it may have missed.
import type { FeedEvent, MonorepoId, MonorepoSummary } from "@pando/contract";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { decodeFrame } from "../api/client";
import { monorepoRef } from "../api/names";
import { applyLine } from "./lines";
import { startMonorepoFeed } from "./monorepo";

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
          // Joining or leaving an org also changes your orgs and its page.
          refetchAll();
          void qc.invalidateQueries({ queryKey: ["orgs"] });
          void qc.invalidateQueries({ queryKey: ["owner"] });
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

/** The most large monorepos the home follows by their own sockets (audit M2, web-api's costing: the server needs nothing). */
const LARGE_SOCKETS = 5;

/** Past that many, the home reads its log again this often. */
export const LARGE_REFETCH_MS = 60_000;

/**
 * A large monorepo (over 100 members) sends no lines to the person's socket.
 * The home follows the 5 most recently active by their own feed sockets, each
 * resuming from its last line; it answers true when there are more than 5,
 * so the home reads its log again every minute for the rest.
 */
export function useLargeFeeds(lines: readonly MonorepoSummary[]): boolean {
  const qc = useQueryClient();
  const large = lines.filter((m) => m.large).sort(byActivity);

  // The followed set, in a stable order: a change of rank alone opens or closes nothing.
  const followed = large
    .slice(0, LARGE_SOCKETS)
    .map((m) => m.full_name)
    .sort()
    .join(" ");

  useEffect(() => {
    if (!followed) return;

    const stops = followed.split(" ").map((full) => {
      const [owner = "", name = ""] = full.split("/");

      return startMonorepoFeed(qc, monorepoRef(owner, name));
    });

    return () => {
      for (const stop of stops) stop();
    };
  }, [qc, followed]);

  return large.length > LARGE_SOCKETS;
}
