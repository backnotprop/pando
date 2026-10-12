// Git objects by hash, cached at the edge (FILES.md, the spike's shape A).
//
// `Objects` is a named entrypoint of this Worker with Workers Caching on
// (wrangler.jsonc `exports`); the default entrypoint has it off. It has no
// public URL: the Worker reaches it through `ctx.exports.Objects`, after it
// has checked who is asking and that the repo is theirs. Every path carries
// the Artifacts repo beside the hash, and reads go through that repo's
// handle, so a hash from another repo is a 404 even when that repo cached it.
//
//   GET /commit/<artifacts repo>/<oid>        commit metadata (JSON)
//   GET /tree/<artifacts repo>/<oid>          tree entries (JSON)
//   GET /blob/<artifacts repo>/<oid>          the bytes
//   GET /log/<artifacts repo>/<oid>?limit=n   first parents from a commit (JSON)
//   GET /answer/<artifacts repo>/<key>        a stored answer from R2 (JSON)
//
// Found: `public, max-age=31536000, immutable` (a hash never changes). Not
// found: `no-store`, since the object may be pushed later.

import { exports, WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { withRepo } from "./monorepo/artifacts";
import { addArtifacts, currentTiming } from "./timing";

const OID = /^[0-9a-f]{40}$/;

const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

const KEY = /^[a-z]+\/[0-9a-f]{40}\/[0-9a-f]{40}$/;

const FOREVER = "public, max-age=31536000, immutable";

function found(body: BodyInit, type: string): Response {
  return new Response(body, { headers: { "content-type": type, "cache-control": FOREVER } });
}

function missing(): Response {
  return new Response("not found\n", { status: 404, headers: { "cache-control": "no-store" } });
}

export class Objects extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response("method\n", { status: 405, headers: { "cache-control": "no-store" } });
    const url = new URL(request.url);
    const [, kind, repo, ...rest] = url.pathname.split("/");

    if (!REPO.test(repo ?? "")) return missing();
    const env = this.env;

    if (kind === "answer") {
      const key = rest.join("/");

      if (!KEY.test(key) || !env.CACHE) return missing();
      const o = await env.CACHE.get(`answers/${repo}/${key}.json`);

      return o ? found(o.body, "application/json") : missing();
    }

    const oid = rest[0] ?? "";

    if (rest.length !== 1 || !OID.test(oid)) return missing();

    try {
      if (kind === "commit") {
        const c = await withRepo(env, repo, (r) => r.readCommit(oid));

        return c ? found(JSON.stringify(c), "application/json") : missing();
      }

      if (kind === "tree") {
        const t = await withRepo(env, repo, (r) => r.readTree(oid));

        return t ? found(JSON.stringify(t), "application/json") : missing();
      }

      if (kind === "blob") {
        const b = await withRepo(env, repo, (r) => r.readBlob(oid));

        return b ? found(b.stream(), "application/octet-stream") : missing();
      }

      if (kind === "log") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 200) || 200, 1), 1000);
        const commits = await withRepo(env, repo, (r) => r.log({ ref: oid, limit }));

        return commits.length ? found(JSON.stringify(commits), "application/json") : missing();
      }
    } catch (err) {
      // An unknown hash can throw (INVALID_INPUT, INTERNAL_ERROR): not found, never cached.
      console.warn({ msg: "pando.objects", kind, repo, error: err instanceof Error ? err.message : String(err) });

      return missing();
    }

    return missing();
  }
}

/** Edge hits and misses, counted by a walk (its budget is on misses: those reach Artifacts). */
export interface ObjectStats {
  hits: number;
  misses: number;
}

/** The Worker's side: fetch from the cached entrypoint, counting edge hits and misses on the request's line. */
export interface ObjectsClient {
  json<T>(path: string, stats?: ObjectStats): Promise<T | null>;
  raw(path: string, stats?: ObjectStats): Promise<Response | null>;
}

export function objectsClient(): ObjectsClient {
  const fetcher = exports.Objects;

  const get = async (path: string, stats?: ObjectStats): Promise<Response | null> => {
    const start = Date.now();
    const res = await fetcher.fetch(`https://objects.internal${path}`);
    const hit = res.headers.get("cf-cache-status") === "HIT";
    const [, kind = "", repo = null] = path.split("/");

    // A miss for a git object ran the entrypoint's Artifacts read, whose own
    // timing stays in that call's context: count it here as Artifacts time.
    if (!hit && kind !== "answer") addArtifacts(`objects ${kind}`, repo, start, Date.now());

    if (stats) stats[hit ? "hits" : "misses"]++;
    const t = currentTiming();

    if (t) {
      const f = hit ? "objects_hits" : "objects_misses";
      t.fields[f] = Number(t.fields[f] ?? 0) + 1;
    }

    if (res.status === 404) {
      await res.body?.cancel();

      return null;
    }

    if (!res.ok) throw new Error(`objects ${path.split("/")[1]}: ${res.status}`);

    return res;
  };

  const read = async (path: string, stats?: ObjectStats): Promise<{ value: Json; text: string } | null> => {
    const r = await get(path, stats);

    if (!r) return null;
    const text = await r.text();

    return { value: JSON.parse(text), text };
  };

  return {
    async json<T>(path: string, stats?: ObjectStats) {
      const kind = path.split("/")[1];
      const out = kind === "commit" || kind === "tree" ? await kept(path, stats, read) : (await read(path, stats))?.value ?? null;

      // SAFETY: the entrypoint answers each kind with that kind's JSON (CommitMeta, TreeEntry[], CommitMeta[], a stored answer); T is what the caller asked for by path.
      return out as T | null;
    },
    raw: get,
  };
}

// ── Commits and trees kept in this isolate ──────────────────────────────────
//
// Parsed commits and trees, in front of the edge cache: a commit or tree is
// immutable and named by its hash, and the key is the path, which carries the
// repo, so an object is only ever served for the repo it was read through.
// A read in flight is shared: two requests for one object make one call.
// Blobs, logs and stored answers are not kept. Values are shared between
// requests: read them, never change them. Bounded by both caps below; the
// least recently used goes first.

/** 32 MiB, estimated as 2 bytes per JSON character: a quarter of an isolate's 128 MB, leaving the rest to requests (a 1 MiB file colouring, a diff). */
export const KEPT_BYTES = 32 * 1024 * 1024;

/** 50,000 objects: about one 700-byte commit or small tree each at the byte cap, so small objects cannot grow the map's own overhead past it. */
export const KEPT_ENTRIES = 50_000;

/** How long a request waits on another's read of the same object before reading it itself (a miss takes 0.3 to 1.3 s in wrangler dev). */
const SHARED_WAIT_MS = 5000;

const LATE = Symbol("late");

/** Parsed JSON, as the entrypoint sends it. */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface Kept {
  value: Promise<Json>;
  /** The estimated size once read; 0 while in flight. */
  bytes: number;
}

const keptObjects = new Map<string, Kept>();

let keptBytes = 0;

function evict(): void {
  for (const [key, k] of keptObjects) {
    if (keptBytes <= KEPT_BYTES && keptObjects.size <= KEPT_ENTRIES) return;
    keptObjects.delete(key);
    keptBytes -= k.bytes;
  }
}

async function kept(path: string, stats: ObjectStats | undefined, read: (path: string, stats?: ObjectStats) => Promise<{ value: Json; text: string } | null>): Promise<Json> {
  const t = currentTiming();
  const have = keptObjects.get(path);

  if (have) {
    // Most recently used last.
    keptObjects.delete(path);
    keptObjects.set(path, have);

    if (stats) stats.hits++;

    if (t) t.fields.objects_kept = Number(t.fields.objects_kept ?? 0) + 1;

    if (have.bytes) return have.value;
    // Another request's read, still in flight: this one waits on Artifacts
    // too. If that request is cancelled (its client went away), its read
    // never ends: after SHARED_WAIT_MS this one reads for itself.
    const start = Date.now();
    const late = new Promise<typeof LATE>((r) => setTimeout(() => r(LATE), SHARED_WAIT_MS));

    try {
      const first = await Promise.race([have.value, late]);

      return first === LATE ? ((await read(path, stats))?.value ?? null) : first;
    } finally {
      addArtifacts(`objects ${path.split("/")[1]} (shared)`, path.split("/")[2] ?? null, start, Date.now());
    }
  }

  const k: Kept = { value: Promise.resolve(null), bytes: 0 };

  k.value = read(path, stats).then((r) => {
    const mine = keptObjects.get(path) === k;

    // Not found is not kept: the object may be pushed later.
    if (!r) {
      if (mine) keptObjects.delete(path);

      return null;
    }

    if (mine) {
      k.bytes = r.text.length * 2;
      keptBytes += k.bytes;
      evict();
    }

    return r.value;
  });
  keptObjects.set(path, k);
  evict();
  // A failed read is not kept: the next asks again.
  k.value.catch(() => {
    if (keptObjects.get(path) === k) keptObjects.delete(path);
  });

  return k.value;
}
