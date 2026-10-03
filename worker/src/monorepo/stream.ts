// The per-monorepo event stream (GET /v1/monorepos/{m}/events) is built but
// ON HOLD (pando-ops, 2026-10-03) until the architecture lane decides where
// events live (a Durable Object, Queues or K2). While false: nothing is
// written to the events table, no branch rows are computed for it, the meta
// layer forwards nothing, and the route answers 501 event_stream_on_hold.
export const EVENT_STREAM = false;

/** The topics an event is sent on (sockets subscribe with ?topics=, as acceptWebSocket tags). */
export function eventTags(e: { kind: string; repo?: string | null; collection: string | null }): string[] {
  const t = ["all", `kind:${e.kind}`];
  if (e.repo) t.push(`repo:${e.repo}`);
  if (e.collection === "default_heads") {
    t.push("main");
    if (e.repo) t.push(`main:${e.repo}`);
  }
  if (e.collection === "meta_files" || e.collection === "connections") t.push("meta");
  return t;
}

/** ?topics=a,b (default all); null when invalid. At most 10 (Cloudflare's tag limit per socket). */
export function parseTopics(q: string | null): string[] | null {
  if (q === null || q.trim() === "") return ["all"];
  const topics = [...new Set(q.split(",").map((t) => t.trim()).filter(Boolean))];
  if (!topics.length || topics.length > 10) return null;
  const ok = topics.every((t) => t.length <= 200 && /^(all|main|meta|main:[A-Za-z0-9._-]+|repo:[A-Za-z0-9._-]+|kind:[a-z._]+)$/.test(t));
  return ok ? topics : null;
}

