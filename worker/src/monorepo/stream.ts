// The per-monorepo event stream (GET /v1/monorepos/{m}/events), on since
// 2026-10-03 after the architecture review: events are written in the same
// turn as the change, from the monorepo object's own rows (no Artifacts work),
// every one kept, and sent to hibernating sockets by topic. Set false to stop
// writing events; the route then answers 501 event_stream_on_hold.
export const EVENT_STREAM = true;

/** The topics an event is sent on (sockets subscribe with ?topics=, as acceptWebSocket tags). */
export function eventTags(e: { kind: string; repo?: string | null; collection: string | null; topics?: string[] }): string[] {
  const t = ["all", `kind:${e.kind}`, ...(e.topics ?? [])];

  if (e.repo) t.push(`repo:${e.repo}`);

  if (e.collection === "default_heads") {
    t.push("main");

    if (e.repo) t.push(`main:${e.repo}`);
  }

  if (e.collection === "meta_files" || e.collection === "presence") t.push("meta");

  return t;
}

/** ?topics=a,b (default all); null when invalid. At most 10 (Cloudflare's tag limit per socket). */
export function parseTopics(q: string | null): string[] | null {
  if (q === null || q.trim() === "") return ["all"];
  const topics = [...new Set(q.split(",").map((t) => t.trim()).filter(Boolean))];

  if (!topics.length || topics.length > 10) return null;
  // `feed`: the activity lines (C25), as the person's feed shows them, for a large monorepo on the home.
  // `agents` and `agent:<n>`: agent sessions (agents/store.ts); `understand` and `understand:<n>`: Understand pages; `sessions` and `session:<id>`: recorded sessions (sessions/store.ts).
  const ok = topics.every((t) => t.length <= 200 && /^(all|main|meta|feed|issues|issue:[1-9][0-9]{0,8}|agents|agent:[1-9][0-9]{0,8}|understand|understand:[1-9][0-9]{0,8}|sessions|session:s_[0-9A-HJKMNP-TV-Z]{26}|main:[A-Za-z0-9._-]+|repo:[A-Za-z0-9._-]+|kind:[a-z._]+)$/.test(t));

  return ok ? topics : null;
}

