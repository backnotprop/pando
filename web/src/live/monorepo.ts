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
import { keepOpen } from "./socket";

export function startMonorepoFeed(qc: QueryClient, m: MonorepoRef): () => void {
  let lastN: number | null = null;

  const refetch = () => void qc.invalidateQueries({ queryKey: ["activity", m.full] });

  return keepOpen(() => Routes.monorepoFeedSocketPath(m.owner, m.name, lastN), {
    frame: (data) => {
      const f = decodeMonorepoFrame(data);

      if (!f) return;

      switch (f.type) {
        case "feed":
          lastN = Math.max(lastN ?? 0, f.n);
          applyLine(qc, f.event);
          break;
        case "caught_up":
          lastN = f.feed_n ?? lastN;
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
    },
  });
}
