// The per-monorepo event stream (GET /v1/monorepos/{m}/events) is built but
// ON HOLD (pando-ops, 2026-10-03) until the architecture lane decides where
// events live (a Durable Object, Queues or K2). While false: nothing is
// written to the events table, no branch rows are computed for it, the meta
// layer forwards nothing, and the route answers 501 event_stream_on_hold.
export const EVENT_STREAM = false;
