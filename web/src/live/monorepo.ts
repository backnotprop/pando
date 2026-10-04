// One monorepo's own socket (its event stream with topics=feed), open while a
// page of that monorepo is, and on the home for its large monorepos
// (live/feed.ts): its activity lines, numbered `n`. A monorepo of over 100
// members sends none to the person's socket, so its pages need this; for the
// others it brings branch and check changes to the page at once. It
// reconnects with backoff and asks for what it missed (feed_since, kept per
// monorepo for the tab's life, so a socket opened again resumes too); past
// 500 missed lines the server says feed_resync, and the logs are refetched.
import { Routes } from "@pando/contract";
import type { QueryClient } from "@tanstack/react-query";
import { decodeMonorepoFrame } from "../api/client";
import type { MonorepoRef } from "../api/names";
import { applyLine } from "./lines";
import { keepOpen } from "./socket";

/** The last line number each monorepo's socket saw, by `owner/name`. */
const seen = new Map<string, number>();

export function startMonorepoFeed(qc: QueryClient, m: MonorepoRef): () => void {
  let lastN: number | null = seen.get(m.full) ?? null;

  const keep = (n: number | null) => {
    lastN = n;

    if (n !== null) seen.set(m.full, n);
  };

  // Its own log and the home's, which carries its lines too.
  const refetch = () => void qc.invalidateQueries({ queryKey: ["activity"], predicate: (q) => q.queryKey[1] === null || q.queryKey[1] === m.full });

  return keepOpen(() => Routes.monorepoFeedSocketPath(m.owner, m.name, lastN), {
    frame: (data) => {
      const f = decodeMonorepoFrame(data);

      if (!f) return;

      switch (f.type) {
        case "feed":
          keep(Math.max(lastN ?? 0, f.n));
          applyLine(qc, f.event);
          break;
        case "caught_up":
          keep(f.feed_n ?? lastN);
          break;
        case "feed_resync":
          keep(f.feed_n);
          refetch();
          break;
        case "resync":
          refetch();
          break;
        case "error":
          break;
      }
    },
  });
}
