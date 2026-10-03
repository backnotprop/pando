// Git protocol v2 `object-info` at the git door. Artifacts does not offer it,
// so the door adds it to the v2 advertisement and answers it itself: object
// sizes come from a per-repo index in the monorepo object, filled on a miss by
// reading the blob through the binding. Mounts use it to list file sizes
// (ls -l, Finder, git's index) without downloading the files.

import type { Env } from "../env";
import { withRepo } from "./artifacts";
import { concat, FLUSH, pkt, pktLines } from "./pktline";
import type { MonorepoObject } from "./object";
import type { RepoRecord } from "./types";

const dec = new TextDecoder();

const MAX_REQUEST = 1 << 20;

const MAX_OIDS = 10_000;

const CONCURRENCY = 4;

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
  const oids = args.filter((a) => a.startsWith("oid ")).map((a) => a.slice(4).trim()).slice(0, MAX_OIDS);

  if (!oids.length) return FLUSH;
  const valid = oids.filter((o) => /^[0-9a-f]{40}$/.test(o));
  const sizes: Record<string, number> = wantSize && valid.length ? await stub.objectSizes(repo.name, valid) : {};
  const missing = wantSize ? [...new Set(valid.filter((o) => sizes[o] === undefined))] : [];

  if (missing.length) {
    const found: [string, number][] = [];
    await withRepo(env, repo.artifacts_name, async (r) => {
      let i = 0;
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, missing.length) }, async () => {
          while (i < missing.length) {
            const oid = missing[i++];
            const blob = await r.readBlob(oid).catch(() => null);

            if (blob) {
              sizes[oid] = blob.size;
              found.push([oid, blob.size]);
            }
          }
        }),
      );
    });

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
