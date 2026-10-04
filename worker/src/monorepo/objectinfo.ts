// Git protocol v2 `object-info` at the git door. Artifacts does not offer it,
// so the door adds it to the v2 advertisement and answers it itself: object
// sizes come from a per-repo index in the monorepo object, filled on a miss
// from one git fetch of the missing blobs, whose pack is read here. Mounts use it to list file sizes
// (ls -l, Finder, git's index) without downloading the files.

import type { Env } from "../env";
import { gitRequest, withRepo } from "./artifacts";
import { concat, FLUSH, pkt, pktLines } from "./pktline";
import type { MonorepoObject } from "./object";
import { packBlobSizes } from "./thinpack";
import type { RepoRecord } from "./types";

const dec = new TextDecoder();

const DELIM = new TextEncoder().encode("0001");

const MAX_REQUEST = 1 << 20;

const MAX_OIDS = 10_000;

// Sizes the index lacks come from one git fetch per FETCH_WANTS blob ids: the
// pack is read here and each object hashed. Reading blobs one at a time
// through the binding sized a cold repository at 33 to 50 files/s (1,000 in
// 20 to 30 s); one fetch of 1,000 blobs took 1.7 s (2026-10-04,
// research/operational/mac-mount-downloads-2026-10-04.md).
const FETCH_WANTS = 1_000;

// Blobs no pack answered (an id that is not a blob) are read one at a time,
// at most this many per request; the rest come back with an empty size.
const READS_MAX = 200;

const READS_AT_ONCE = 8;

/** Add `object-info` to a v2 capability advertisement (before its last flush). */
export function withObjectInfo(adv: Uint8Array): Uint8Array {
  const text = dec.decode(adv);

  if (!text.includes("version 2") || /\bobject-info\b/.test(text)) return adv;

  if (adv.length < 4 || text.slice(-4) !== "0000") return adv;

  return concat([adv.subarray(0, adv.length - 4), pkt("object-info\n"), FLUSH]);
}

export interface PeekedRequest {
  /** The request's lines after the delimiter, when it is `command=object-info`. */
  objectInfo: string[] | null;
  /** The request body to forward unchanged otherwise. */
  body: ReadableStream<Uint8Array> | null;
}

/** Look at a v2 upload-pack request's command without disturbing the bytes forwarded. */
export async function peekCommand(body: ReadableStream<Uint8Array>, gzip: boolean): Promise<PeekedRequest> {
  const [raw, probe] = body.tee();
  const reader = (gzip ? probe.pipeThrough(new DecompressionStream("gzip")) : probe).getReader();
  let buf: Uint8Array = new Uint8Array(0);

  const fill = async (n: number) => {
    while (buf.length < n) {
      const { done, value } = await reader.read();

      if (done) return false;
      buf = concat([buf, value]);

      if (buf.length > MAX_REQUEST) return false;
    }

    return true;
  };

  const isObjectInfo = (await fill(4)) && (await (async () => {
    const len = parseInt(dec.decode(buf.subarray(0, 4)), 16);

    if (!(len > 4) || !(await fill(len))) return false;

    return dec.decode(buf.subarray(4, len)).replace(/\n$/, "") === "command=object-info";
  })());

  if (!isObjectInfo) {
    await reader.cancel().catch(() => {});

    return { objectInfo: null, body: raw };
  }

  // Read the rest of this small request; nothing is forwarded.
  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;
    buf = concat([buf, value]);

    if (buf.length > MAX_REQUEST) break;
  }

  await raw.cancel().catch(() => {});
  const lines: string[] = [];
  let afterDelim = false;

  for (const line of pktLines(buf)) {
    if (line === null) {
      if (afterDelim) break;
      afterDelim = true;
      continue;
    }

    if (afterDelim) lines.push(dec.decode(line).replace(/\n$/, ""));
  }

  return { objectInfo: lines, body: null };
}

/** The object-info reply, in git's own format (protocol-caps.c): `size`, then `<oid> <size>` lines. */
export async function answerObjectInfo(
  env: Env,
  stub: DurableObjectStub<MonorepoObject>,
  repo: RepoRecord,
  args: string[],
): Promise<Uint8Array> {
  const wantSize = args.includes("size");
  const oids = args.flatMap((a) => (a.startsWith("oid ") ? [a.slice(4).trim()] : [])).slice(0, MAX_OIDS);

  if (!oids.length) return FLUSH;
  const valid = oids.filter((o) => /^[0-9a-f]{40}$/.test(o));
  const sizes: Record<string, number> = wantSize && valid.length ? await stub.objectSizes(repo.name, valid) : {};
  const missing = wantSize ? [...new Set(valid.filter((o) => sizes[o] === undefined))] : [];

  if (missing.length) {
    const found: [string, number][] = [];

    for (let i = 0; i < missing.length; i += FETCH_WANTS) {
      for (const [oid, size] of await fetchedSizes(env, repo, missing.slice(i, i + FETCH_WANTS))) {
        if (sizes[oid] === undefined) {
          sizes[oid] = size;
          found.push([oid, size]);
        }
      }
    }

    const unread = missing.filter((o) => sizes[o] === undefined).slice(0, READS_MAX);

    if (unread.length) {
      await withRepo(env, repo.artifacts_name, async (r) => {
        for (let i = 0; i < unread.length; i += READS_AT_ONCE) {
          await Promise.all(unread.slice(i, i + READS_AT_ONCE).map(async (oid) => {
            const blob = await r.readBlob(oid).catch(() => null);

            if (blob) {
              sizes[oid] = blob.size;
              found.push([oid, blob.size]);
            }
          }));
        }
      });
    }

    if (found.length) await stub.recordObjectSizes(repo.name, found);
  }

  const out: Uint8Array[] = [];

  if (wantSize) out.push(pkt("size"));

  for (const oid of oids) {
    out.push(pkt(wantSize ? `${oid} ${sizes[oid] ?? ""}` : oid));
  }

  out.push(FLUSH);

  return concat(out);
}

/** Blob sizes from one protocol v2 fetch of exactly these ids; empty when the fetch or its pack fails. */
async function fetchedSizes(env: Env, repo: RepoRecord, oids: string[]): Promise<Map<string, number>> {
  const body = concat([
    pkt("command=fetch\n"), pkt("object-format=sha1\n"), DELIM, pkt("no-progress\n"), pkt("ofs-delta\n"),
    ...oids.map((o) => pkt(`want ${o}\n`)), pkt("done\n"), FLUSH,
  ]);

  try {
    const res = await gitRequest(env, repo, "/git-upload-pack", "read", {
      method: "POST",
      headers: { "git-protocol": "version=2", "content-type": "application/x-git-upload-pack-request", accept: "application/x-git-upload-pack-result" },
      body,
    });

    if (!res.ok) {
      await res.body?.cancel();

      return new Map();
    }

    const pack = packOf(new Uint8Array(await res.arrayBuffer()));

    return (pack && (await packBlobSizes(pack))) ?? new Map();
  } catch {
    return new Map();
  }
}

/** The pack in a v2 fetch reply: the pkt-lines after `packfile`, side-band 1. Null on an error band or no pack. */
function packOf(reply: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [];
  let inPack = false;

  for (const line of pktLines(reply)) {
    if (line === null) continue;

    if (!inPack) {
      inPack = dec.decode(line) === "packfile\n";
      continue;
    }

    if (line[0] === 1) parts.push(line.subarray(1));
    else if (line[0] === 3) return null;
  }

  return parts.length ? concat(parts) : null;
}
