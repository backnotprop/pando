// Where a request's time goes: waiting on Artifacts, waiting for a repo's
// write gate, waiting on Durable Objects, and the Worker's own time. One
// structured log line per request (msg "pando.timing"), which Workers
// observability indexes field by field. No storage.
//
// A request (or a queue message, or a write inside the monorepo object) runs
// in a context (AsyncLocalStorage); every Artifacts call made under it, binding
// or HTTP, records its interval. Overlapping calls are counted once
// (`artifacts_ms` is wall time; `artifacts_sum_ms` adds them up).
//
// Fields: kind (door, api, queue, object), route, method, monorepo, repo,
// status, total_ms, artifacts_ms, artifacts_sum_ms, artifacts_calls,
// gate_ms, objects_ms, worker_ms (total minus Artifacts, gate and objects,
// each as wall time), slowest {op, repo, ms}, slow_calls (each Artifacts call
// over SLOW_MS, at most 8), plus what the caller adds (bytes, refs, colo).
// Never a token, a credential or a body.

import { AsyncLocalStorage } from "node:async_hooks";

/** An Artifacts call this long is listed in slow_calls. */
export const SLOW_MS = 1000;

type Lane = "artifacts" | "gate" | "objects";

export interface Timing {
  kind: string;
  fields: Record<string, unknown>;
  start: number;
  spans: Record<Lane, [number, number][]>;
  calls: number;
  slowest: { op: string; repo: string | null; ms: number } | null;
  slow: { op: string; repo: string | null; ms: number }[];
  done: boolean;
}

const als = new AsyncLocalStorage<Timing>();

export function startTiming(kind: string, fields: Record<string, unknown> = {}): Timing {
  return { kind, fields, start: Date.now(), spans: { artifacts: [], gate: [], objects: [] }, calls: 0, slowest: null, slow: [], done: false };
}

export function runTimed<T>(t: Timing, fn: () => T): T {
  return als.run(t, fn);
}

export function currentTiming(): Timing | undefined {
  return als.getStore();
}

/** Add fields to the current request's line (repo, status, bytes...). */
export function note(fields: Record<string, unknown>): void {
  const t = als.getStore();
  if (t) Object.assign(t.fields, fields);
}

function record(t: Timing | undefined, lane: Lane, start: number, end: number, op?: string, repo?: string | null): void {
  if (!t) return;
  t.spans[lane].push([start, end]);
  if (lane !== "artifacts" || !op) return;
  t.calls++;
  const ms = end - start;
  const entry = { op, repo: repo ?? null, ms };
  if (!t.slowest || ms > t.slowest.ms) t.slowest = entry;
  if (ms >= SLOW_MS && t.slow.length < 8) t.slow.push(entry);
}

/** Time one Artifacts call (binding or HTTP). */
export async function timeArtifacts<T>(op: string, repo: string | null, fn: () => Promise<T>): Promise<T> {
  const t = als.getStore();
  const s = Date.now();
  try {
    return await fn();
  } finally {
    record(t, "artifacts", s, Date.now(), op, repo);
  }
}

/** Record an Artifacts interval measured elsewhere (a streamed body, a call inside an object). */
export function addArtifacts(op: string, repo: string | null, start: number, end: number): void {
  record(als.getStore(), "artifacts", start, end, op, repo);
}

export async function timeGate<T>(fn: () => Promise<T>): Promise<T> {
  const t = als.getStore();
  const s = Date.now();
  try {
    return await fn();
  } finally {
    record(t, "gate", s, Date.now());
  }
}

/** The gate's own wait, when the object reports it (the rest of the call is object time). */
export function addGate(ms: number): void {
  const t = als.getStore();
  const now = Date.now();
  if (t && ms > 0) record(t, "gate", now - ms, now);
}

/** The length of the union of intervals. */
function wall(spans: [number, number][]): number {
  if (!spans.length) return 0;
  const s = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [a, b] = s[0];
  for (const [x, y] of s.slice(1)) {
    if (x > b) {
      total += b - a;
      [a, b] = [x, y];
    } else if (y > b) b = y;
  }
  return total + (b - a);
}

/** Write the line, once. */
export function finishTiming(t: Timing, fields: Record<string, unknown> = {}): void {
  if (t.done) return;
  t.done = true;
  const total = Date.now() - t.start;
  const artifacts = wall(t.spans.artifacts);
  const gate = wall(t.spans.gate);
  // Object time is the part of object calls not spent waiting on Artifacts or
  // the gate (an object call can contain both: a token mint, a gate wait).
  const all = wall([...t.spans.artifacts, ...t.spans.gate, ...t.spans.objects]);
  const objects = Math.max(0, all - wall([...t.spans.artifacts, ...t.spans.gate]));
  console.log({
    msg: "pando.timing",
    kind: t.kind,
    ...t.fields,
    ...fields,
    total_ms: total,
    artifacts_ms: artifacts,
    artifacts_sum_ms: t.spans.artifacts.reduce((n, [a, b]) => n + (b - a), 0),
    artifacts_calls: t.calls,
    gate_ms: gate,
    objects_ms: objects,
    worker_ms: Math.max(0, total - all),
    slowest: t.slowest,
    slow_calls: t.slow.length ? t.slow : undefined,
  });
}

/** Run fn in its own context and write its line when it ends (queue messages, writes inside objects). */
export async function timed<T>(kind: string, fields: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const t = startTiming(kind, fields);
  try {
    const out = await runTimed(t, fn);
    finishTiming(t, { status: "ok" });
    return out;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    finishTiming(t, { status: "error", error: typeof code === "string" ? code : err instanceof Error ? err.name : "error" });
    throw err;
  }
}

// ── Wrappers ────────────────────────────────────────────────────────────────

/** An Artifacts repo handle whose calls are timed (readTree, readBlob, log, createToken...). */
export function timedRepo(repo: ArtifactsRepo, name: string): ArtifactsRepo {
  return new Proxy(repo, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      // RPC stubs answer any property name with a remote method, so never call
      // .apply or .bind on one: Reflect.apply invokes it directly.
      if (typeof v !== "function") return v;
      // Symbol methods (Symbol.dispose) run on the real handle, untimed.
      if (typeof prop === "symbol") return (...args: unknown[]) => Reflect.apply(v as (...a: unknown[]) => unknown, target, args);
      return (...args: unknown[]) => timeArtifacts(String(prop), name, () => Reflect.apply(v as (...a: unknown[]) => Promise<unknown>, target, args));
    },
  }) as ArtifactsRepo;
}

/** The Artifacts binding with timed calls; its repo handles are timed too. */
export function timedArtifacts(ns: Artifacts): Artifacts {
  return new Proxy(ns, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v !== "function" || typeof prop === "symbol") return v;
      if (prop === "get") {
        return async (name: string) => timedRepo(await timeArtifacts("get", name, () => target.get(name)), name);
      }
      return (...args: unknown[]) =>
        timeArtifacts(String(prop), typeof args[0] === "string" ? args[0] : null, () => Reflect.apply(v as (...a: unknown[]) => Promise<unknown>, target, args));
    },
  }) as Artifacts;
}

/** A Durable Object stub whose RPC calls count as object time. */
export function timedStub<S extends object>(stub: S): S {
  return new Proxy(stub, {
    get(target, prop) {
      const v = Reflect.get(target, prop);
      if (typeof v !== "function" || typeof prop === "symbol") return v;
      return async (...args: unknown[]) => {
        const t = als.getStore();
        const s = Date.now();
        try {
          return await Reflect.apply(v as (...a: unknown[]) => unknown, target, args);
        } finally {
          record(t, "objects", s, Date.now());
        }
      };
    },
  });
}

/** Record an interval on a given request (from callbacks that may run outside its context). */
export function recordOn(t: Timing, lane: Lane, start: number, end: number, op?: string, repo?: string | null): void {
  record(t, lane, start, end, op, repo);
}

/**
 * A response body relayed from Artifacts: the time until its last byte is
 * Artifacts time (from `since`, when the request to Artifacts started), and
 * the request's line is written when the body has been sent, has failed, or
 * the client went away.
 */
export function relayTimed(res: Response, t: Timing, op: string, repo: string | null, since: number): Response {
  if (!res.body) {
    recordOn(t, "artifacts", since, Date.now(), op, repo);
    finishTiming(t, { status: res.status });
    return res;
  }
  const reader = res.body.getReader();
  let bytes = 0;
  const end = (outcome: string) => {
    if (t.done) return;
    recordOn(t, "artifacts", since, Date.now(), `${op} (body)`, repo);
    finishTiming(t, { status: res.status, bytes, stream: outcome });
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          ctl.close();
          end("sent");
        } else {
          bytes += value.byteLength;
          ctl.enqueue(value);
        }
      } catch (err) {
        end("failed");
        ctl.error(err);
      }
    },
    cancel(reason) {
      end("client_went_away");
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
