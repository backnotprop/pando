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
import { currentTiming } from "./timing";

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
    const res = await fetcher.fetch(`https://objects.internal${path}`);
    const hit = res.headers.get("cf-cache-status") === "HIT";

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

  return {
    async json<T>(path: string, stats?: ObjectStats) {
      const r = await get(path, stats);

      return r ? r.json<T>() : null;
    },
    raw: get,
  };
}
