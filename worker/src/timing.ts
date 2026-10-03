// Where a request's time goes: waiting on Artifacts, waiting for a repo's
// write gate, waiting on Durable Objects, on D1 (accounts), and the Worker's
// own time. One
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
// gate_ms, objects_ms, d1_ms, worker_ms (total minus Artifacts, gate,
// objects and D1, each as wall time), slowest {op, repo, ms}, slow_calls (each Artifacts call
// over SLOW_MS, at most 8), plus what the caller adds (bytes, refs, colo).
// Never a token, a credential or a body.

import { AsyncLocalStorage } from "node:async_hooks";
import { hasCode } from "./parse";

/** An Artifacts call this long is listed in slow_calls. */
export const SLOW_MS = 1000;

type Lane = "artifacts" | "gate" | "objects" | "d1";

/** A value on the line: Workers observability indexes each field. */
export type LogValue = string | number | boolean | null | undefined | readonly LogValue[] | { readonly [key: string]: LogValue };

/** A line's fields, by name. */
export interface LogFields {
  [field: string]: LogValue;
}

export interface Timing {
  kind: string;
  fields: LogFields;
  start: number;
  spans: Record<Lane, [number, number][]>;
  calls: number;
  slowest: { op: string; repo: string | null; ms: number } | null;
  slow: { op: string; repo: string | null; ms: number }[];
  done: boolean;
}

const als = new AsyncLocalStorage<Timing>();

export function startTiming(kind: string, fields: LogFields = {}): Timing {
  return { kind, fields, start: Date.now(), spans: { artifacts: [], gate: [], objects: [], d1: [] }, calls: 0, slowest: null, slow: [], done: false };
}

export function runTimed<T>(t: Timing, fn: () => T): T {
  return als.run(t, fn);
}

export function currentTiming(): Timing | undefined {
  return als.getStore();
}

/** Add fields to the current request's line (repo, status, bytes...). */
export function note(fields: LogFields): void {
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

/** Time one D1 query or batch (accounts). */
export async function timeD1<T>(fn: () => Promise<T>): Promise<T> {
  const t = als.getStore();
  const s = Date.now();

  try {
    return await fn();
  } finally {
    record(t, "d1", s, Date.now());
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
export function finishTiming(t: Timing, fields: LogFields = {}): void {
  if (t.done) return;
  t.done = true;
  const total = Date.now() - t.start;
  const artifacts = wall(t.spans.artifacts);
  const gate = wall(t.spans.gate);
  // Object time is the part of object calls not spent waiting on Artifacts or
  // the gate (an object call can contain both: a token mint, a gate wait).
  const outer = wall([...t.spans.artifacts, ...t.spans.gate, ...t.spans.objects]);
  const objects = Math.max(0, outer - wall([...t.spans.artifacts, ...t.spans.gate]));
  const all = wall([...t.spans.artifacts, ...t.spans.gate, ...t.spans.objects, ...t.spans.d1]);
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
    d1_ms: t.spans.d1.length ? wall(t.spans.d1) : undefined,
    worker_ms: Math.max(0, total - all),
    slowest: t.slowest,
    slow_calls: t.slow.length ? t.slow : undefined,
  });
}

/** Run fn in its own context and write its line when it ends (queue messages, writes inside objects). */
export async function timed<T>(kind: string, fields: LogFields, fn: () => Promise<T>): Promise<T> {
  const t = startTiming(kind, fields);

  try {
    const out = await runTimed(t, fn);
    finishTiming(t, { status: "ok" });

    return out;
  } catch (err) {
    finishTiming(t, { status: "error", error: hasCode(err) ? err.code : err instanceof Error ? err.name : "error" });
    throw err;
  }
}

// ── Wrappers ────────────────────────────────────────────────────────────────

/** A value with its own disposer: what Workers RPC gives every object a call returns. */
function isDisposable<T>(v: T): v is T & Disposable {
  return typeof v === "object" && v !== null && Symbol.dispose in v && typeof v[Symbol.dispose] === "function";
}

/**
 * Release an RPC result as soon as it arrives. Workers gives every object an
 * RPC call returns its own Symbol.dispose, and Artifacts' results (log,
 * readTree, createToken...) are plain data. Left to the garbage collector,
 * they log "An RPC result was not disposed properly". The data stays usable;
 * the disposer is also dropped, so an object method that hands the result on
 * does not pass the duty to its own caller.
 */
export function released<T>(v: T): T {
  if (!isDisposable(v)) return v;

  try {
    v[Symbol.dispose]();
  } catch {
    // already released
  }

  Reflect.deleteProperty(v, Symbol.dispose);

  return v;
}

/** An Artifacts repo handle whose calls are timed (readTree, readBlob, log, createToken...). */
class TimedRepo implements ArtifactsRepo {
  constructor(
    private readonly repo: ArtifactsRepo,
    private readonly name: string,
  ) {}

  private time<T>(op: string, call: () => Promise<T>): Promise<T> {
    return timeArtifacts(op, this.name, async () => released(await call()));
  }

  createToken(...args: Parameters<ArtifactsRepo["createToken"]>) {
    return this.time("createToken", () => this.repo.createToken(...args));
  }

  listTokens() {
    return this.time("listTokens", () => this.repo.listTokens());
  }

  revokeToken(...args: Parameters<ArtifactsRepo["revokeToken"]>) {
    return this.time("revokeToken", () => this.repo.revokeToken(...args));
  }

  info() {
    return this.time("info", () => this.repo.info());
  }

  readBlob(...args: Parameters<ArtifactsRepo["readBlob"]>) {
    return this.time("readBlob", () => this.repo.readBlob(...args));
  }

  readTree(...args: Parameters<ArtifactsRepo["readTree"]>) {
    return this.time("readTree", () => this.repo.readTree(...args));
  }

  readCommit(...args: Parameters<ArtifactsRepo["readCommit"]>) {
    return this.time("readCommit", () => this.repo.readCommit(...args));
  }

  readFile(...args: Parameters<ArtifactsRepo["readFile"]>) {
    return this.time("readFile", () => this.repo.readFile(...args));
  }

  log(...args: Parameters<ArtifactsRepo["log"]>) {
    return this.time("log", () => this.repo.log(...args));
  }

  fork(...args: Parameters<ArtifactsRepo["fork"]>) {
    return this.time("fork", () => this.repo.fork(...args));
  }

  /** Runs on the real handle, untimed. */
  [Symbol.dispose](): void {
    this.repo[Symbol.dispose]();
  }
}

/** An Artifacts repo handle whose calls are timed (readTree, readBlob, log, createToken...). */
export function timedRepo(repo: ArtifactsRepo, name: string): ArtifactsRepo {
  return new TimedRepo(repo, name);
}

/** The Artifacts binding with timed calls; its repo handles are timed too. */
class TimedArtifacts implements Artifacts {
  constructor(private readonly ns: Artifacts) {}

  create(...args: Parameters<Artifacts["create"]>) {
    return timeArtifacts("create", args[0], async () => released(await this.ns.create(...args)));
  }

  async get(name: string) {
    return timedRepo(await timeArtifacts("get", name, () => this.ns.get(name)), name);
  }

  import(...args: Parameters<Artifacts["import"]>) {
    return timeArtifacts("import", null, async () => released(await this.ns.import(...args)));
  }

  list(...args: Parameters<Artifacts["list"]>) {
    return timeArtifacts("list", null, async () => released(await this.ns.list(...args)));
  }

  delete(name: string) {
    return timeArtifacts("delete", name, async () => released(await this.ns.delete(name)));
  }
}

/** The Artifacts binding with timed calls; its repo handles are timed too. */
export function timedArtifacts(ns: Artifacts): Artifacts {
  return new TimedArtifacts(ns);
}

/** A remote method. R is what the object's method declares; the proxy below only passes it on. */
type RemoteMethod = <R>(...args: never[]) => Promise<R>;

/** What a stub answers for a name: a remote method; undefined for `then`, so a stub is not a promise; plain values for `id` and `name`. */
type StubMember = RemoteMethod | DurableObjectId | string | undefined;

/** A Durable Object stub seen by member name, as the proxy's trap reads it. */
interface StubMembers {
  readonly [member: string | symbol]: StubMember;
}

/** The same stub seen by method name, once the member is known to be a method. */
interface StubMethods {
  readonly [member: string]: RemoteMethod;
}

function isRemoteMethod(v: StubMember): v is RemoteMethod {
  return typeof v === "function";
}

function isSymbolKey(p: string | symbol): p is symbol {
  return typeof p === "symbol";
}

/**
 * Times each remote call. A method is called as the stub's own member (native
 * ones, fetch and connect, need the stub as `this`), never through .call,
 * .apply or .bind: a stub answers those names with remote methods too.
 */
const stubCalls: ProxyHandler<object> = {
  get(target, prop) {
    // SAFETY: timedStub's only targets are Durable Object stubs (its callers
    // pass a namespace's getByName result), and a stub answers every member
    // name with one of StubMember's kinds.
    const members = target as StubMembers;
    const v = members[prop];

    if (!isRemoteMethod(v) || isSymbolKey(prop)) return v;
    // SAFETY: the member at prop is a method (checked just above).
    const methods = target as StubMethods;

    return async (...args: never[]) => {
      const t = als.getStore();
      const s = Date.now();

      try {
        return released(await methods[prop](...args));
      } finally {
        record(t, "objects", s, Date.now());
      }
    };
  },
};

/** A Durable Object stub whose RPC calls count as object time. */
export function timedStub<S extends object>(stub: S): S {
  return new Proxy<S>(stub, stubCalls);
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
