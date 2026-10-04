// What an activity line changes in the cache, wherever it arrives from (the
// person's socket or a monorepo's): it takes its place in the logs, plays its
// arrival once, and refreshes the data it touched.
import type { EventsPage, FeedEvent } from "@pando/contract";
import type { InfiniteData, InvalidateQueryFilters, QueryClient } from "@tanstack/react-query";
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

/** Lines already applied, for a minute: a monorepo's page gets each line twice (the person's socket and the monorepo's own). */
const applied = new Set<string>();

/** Reads a line started, by query key: true when another line asked for them again while they ran. */
const reading = new Map<string, boolean>();

/**
 * Reads again what a line touched. A read already running is kept, not
 * restarted (cancelRefetch: false), so a burst of lines never starves it; a
 * line that came while it ran gets one more read after it, so no change is
 * missed.
 */
function refresh(qc: QueryClient, filters: InvalidateQueryFilters) {
  const key = JSON.stringify(filters.queryKey);

  if (reading.has(key)) {
    reading.set(key, true);

    return;
  }

  reading.set(key, false);
  void qc.invalidateQueries(filters, { cancelRefetch: false }).finally(() => {
    const again = reading.get(key);

    reading.delete(key);

    if (again) refresh(qc, filters);
  });
}

export function applyLine(qc: QueryClient, e: FeedEvent): void {
  const key = lineKey(e);
  const first = !applied.has(key);

  if (first) {
    applied.add(key);
    setTimeout(() => applied.delete(key), 60_000);
    markArrived(key);
  }

  const [owner, name] = e.monorepo.split("/");

  // The logs it belongs in: all, its monorepo's, and its owner's (an org's page). They take a line again
  // (a fuller summary replaces it); its arrival, machine and reads go once.
  for (const scope of [null, e.monorepo, { owner }]) {
    qc.setQueryData<InfiniteData<EventsPage, string>>(["activity", scope], (data) => data && withLine(data, e));
  }

  if (!first) return;
  patchMachineActivity(qc, e);

  if (e.kind === "meta.saved") {
    refresh(qc, { queryKey: ["m", owner, name, "meta"] });

    return;
  }

  // A push, a merge, a check or a review: that repo's branches, pages and files. A branch's own record
  // and its checks' runs come as rows on the branch page's socket (live/rows.ts), so they are not read again here.
  if (e.repo) refresh(qc, { queryKey: ["m", owner, name, "r", e.repo], predicate: (q) => !rowFed(q.queryKey) });

  if (e.kind === "push" || e.kind === "merged") refresh(qc, { queryKey: ["m", owner, name, "heads"] });
}
