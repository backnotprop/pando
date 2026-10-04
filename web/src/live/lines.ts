// What an activity line changes in the cache, wherever it arrives from (the
// person's socket or a monorepo's): it takes its place in the logs, plays its
// arrival once, and refreshes the data it touched.
import type { EventsPage, FeedEvent } from "@pando/contract";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { lineKey, markArrived } from "./arrivals";
import { patchMachineActivity } from "./rows";

/** Newest first by the display key (at, monorepo_id, seq), as the server orders pages. */
function newer(a: FeedEvent, b: FeedEvent): boolean {
  if (a.at !== b.at) return a.at > b.at;

  if (a.monorepo_id !== b.monorepo_id) return a.monorepo_id > b.monorepo_id;

  return a.seq > b.seq;
}

/** Put a line in a log: replace it where it is (a fuller summary), else place it by its key. */
function withLine(data: InfiniteData<EventsPage, string>, e: FeedEvent): InfiniteData<EventsPage, string> {
  const key = lineKey(e);
  const replaced = data.pages.map((p) => ({ ...p, events: p.events.map((x) => (lineKey(x) === key ? e : x)) }));

  if (replaced.some((p) => p.events.includes(e))) return { ...data, pages: replaced };

  const [first, ...rest] = data.pages;

  if (!first) return data;

  const at = first.events.findIndex((x) => newer(e, x));
  const events = at === -1 ? [...first.events, e] : [...first.events.slice(0, at), e, ...first.events.slice(at)];

  return { ...data, pages: [{ ...first, events }, ...rest] };
}

/** ["m", owner, name, "r", repo, "branch", name], its diff [..., "branch", name, "diff"] and [..., "runs", sha]: kept current by rows. */
const rowFed = (key: readonly unknown[]) => (key[5] === "branch" && (key.length === 7 || key[7] === "diff")) || key[5] === "runs";

export function applyLine(qc: QueryClient, e: FeedEvent): void {
  markArrived(lineKey(e));

  const [owner, name] = e.monorepo.split("/");

  // The logs it belongs in: all, its monorepo's, and its owner's (an org's page).
  for (const scope of [null, e.monorepo, { owner }]) {
    qc.setQueryData<InfiniteData<EventsPage, string>>(["activity", scope], (data) => data && withLine(data, e));
  }

  patchMachineActivity(qc, e);

  if (e.kind === "meta.saved") {
    void qc.invalidateQueries({ queryKey: ["m", owner, name, "meta"] });

    return;
  }

  // A push, a merge, a check or a review: that repo's branches, pages and files. A branch's own record
  // and its checks' runs come as rows on the branch page's socket (live/rows.ts), so they are not read again here.
  if (e.repo) void qc.invalidateQueries({ queryKey: ["m", owner, name, "r", e.repo], predicate: (q) => !rowFed(q.queryKey) });

  if (e.kind === "push" || e.kind === "merged") void qc.invalidateQueries({ queryKey: ["m", owner, name, "heads"] });
}
