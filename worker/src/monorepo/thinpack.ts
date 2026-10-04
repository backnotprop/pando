// A pushed pack with its thin tree deltas written whole. git's push sends a
// thin pack: an object can be a delta against an object the repo already
// has (REF_DELTA). Artifacts refuses one case: a tree sent as a delta against
// a tree that Artifacts holds as a delta against that same tree ("stored
// delta chain contains a cycle"). A `git revert` makes it: the reverted-to
// tree goes as a delta against the current tree, which was pushed as a delta
// against it. research/operational/artifacts-delta-cycle-2026-10-04.md.
//
// The same objects in the same order, every other entry's bytes unchanged:
// only REF_DELTA entries whose base is a tree in the repo become whole trees,
// and OFS_DELTA distances are written again for the new positions.
import { inflateSync } from "node:zlib";
import { concat, sha1, toHex, treeObject, type TreeEntry } from "../gitwrite/objects";
import { deflate, objectHeader } from "../gitwrite/pack";

const TREE = 2;

const OFS_DELTA = 6;

const REF_DELTA = 7;

const READS_AT_ONCE = 8;

/** A tree's entries as the repo has them, or null when `sha` is not a tree there. */
export type ReadTree = (sha: string) => Promise<TreeEntry[] | null>;

interface Entry {
  at: number;
  type: number;
  /** The inflated size, from the entry's header. */
  size: number;
  /** Where the zlib stream starts, and where it ends. */
  dataAt: number;
  end: number;
  ofsBase?: number;
  refBase?: string;
}

/** A pack this file cannot read: the push goes on as it was. */
class PackError extends Error {}

/**
 * `pack` with every REF_DELTA against a repo tree written as the whole tree,
 * and how many; null when it has none or cannot be read.
 */
export async function wholeThinTrees(pack: Uint8Array, readTree: ReadTree): Promise<{ pack: Uint8Array; trees: number } | null> {
  try {
    return await rewrite(pack, readTree);
  } catch (err) {
    if (err instanceof PackError) return null;
    throw err;
  }
}

async function rewrite(pack: Uint8Array, readTree: ReadTree): Promise<{ pack: Uint8Array; trees: number } | null> {
  const entries = readEntries(pack);
  const refs = entries.filter((e) => e.type === REF_DELTA);
  const whole = new Map<number, Uint8Array>();

  // A few base reads at a time. A base can be a blob, which the read answers as not a tree.
  for (let i = 0; i < refs.length; i += READS_AT_ONCE) {
    await Promise.all(
      refs.slice(i, i + READS_AT_ONCE).map(async (e) => {
        const base = await treeBytes(e.refBase!, readTree);

        if (base) whole.set(e.at, applyDelta(base, inflate(pack.subarray(e.dataAt, e.end))));
      }),
    );
  }

  if (whole.size === 0) return null;
  const parts: Uint8Array[] = [pack.subarray(0, 12)];
  const moved = new Map<number, number>();
  let at = 12;

  for (const e of entries) {
    moved.set(e.at, at);
    const tree = whole.get(e.at);
    let bytes: Uint8Array;

    if (tree) {
      bytes = concat([objectHeader(TREE, tree.length), await deflate(tree)]);
    } else if (e.type === OFS_DELTA) {
      const base = moved.get(e.ofsBase!);

      if (base === undefined) throw new PackError("an OFS_DELTA base that is not an entry");
      bytes = concat([objectHeader(OFS_DELTA, e.size), ofsBytes(at - base), pack.subarray(e.dataAt, e.end)]);
    } else {
      bytes = pack.subarray(e.at, e.end);
    }

    parts.push(bytes);
    at += bytes.length;
  }

  const body = concat(parts);

  return { pack: concat([body, await sha1(body)]), trees: whole.size };
}

const BLOB = 3;

const TYPE_NAMES = ["", "commit", "tree", "blob", "tag"];

// Whole objects kept for the deltas that build on them; past this they are
// inflated again when needed.
const BASES_MAX = 32 << 20;

/** An object made whole: its type and bytes. */
interface WholeObject {
  type: number;
  data: Uint8Array;
}

/**
 * Each blob's id and size in a fetched pack (git's own fetch, not thin): every
 * object is made whole (deltas applied) and hashed. An entry whose base is not
 * in the pack is left out. Null when the pack cannot be read.
 */
export async function packBlobSizes(pack: Uint8Array): Promise<Map<string, number> | null> {
  try {
    return await blobSizes(pack);
  } catch (err) {
    if (err instanceof PackError) return null;
    throw err;
  }
}

async function blobSizes(pack: Uint8Array): Promise<Map<string, number>> {
  const entries = readEntries(pack);
  const byAt = new Map(entries.map((e) => [e.at, e]));
  const isBase = new Set(entries.flatMap((e) => (e.ofsBase === undefined ? [] : [e.ofsBase])));
  const atOf = new Map<string, number>();
  const kept = new Map<number, WholeObject>();
  let keptBytes = 0;

  const whole = (e: Entry): WholeObject | null => {
    const hit = kept.get(e.at);

    if (hit) return hit;
    let out: WholeObject;

    if (e.type === OFS_DELTA || e.type === REF_DELTA) {
      const baseAt = e.type === OFS_DELTA ? e.ofsBase : atOf.get(e.refBase!);
      const baseEntry = baseAt === undefined ? undefined : byAt.get(baseAt);
      const base = baseEntry ? whole(baseEntry) : null;

      if (!base) return null;
      out = { type: base.type, data: applyDelta(base.data, inflate(pack.subarray(e.dataAt, e.end))) };
    } else {
      out = { type: e.type, data: inflate(pack.subarray(e.dataAt, e.end)) };
    }

    if (isBase.has(e.at) && keptBytes + out.data.length <= BASES_MAX) {
      kept.set(e.at, out);
      keptBytes += out.data.length;
    }

    return out;
  };

  const sizes = new Map<string, number>();

  for (const e of entries) {
    const o = whole(e);

    if (!o) continue;
    const head = new TextEncoder().encode(`${TYPE_NAMES[o.type]} ${o.data.length}\0`);
    const oid = toHex(await sha1(concat([head, o.data])));
    atOf.set(oid, e.at);

    if (o.type === BLOB) sizes.set(oid, o.data.length);
  }

  return sizes;
}

/** The entries of a PACK v2 or v3. Each zlib stream is inflated once to find where it ends. */
function readEntries(pack: Uint8Array): Entry[] {
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);

  if (pack.length < 32 || String.fromCharCode(...pack.subarray(0, 4)) !== "PACK" || ![2, 3].includes(view.getUint32(4))) {
    throw new PackError("not a pack");
  }

  const count = view.getUint32(8);
  const last = pack.length - 20; // the checksum
  const entries: Entry[] = [];
  let pos = 12;

  const next = () => {
    if (pos >= last) throw new PackError("short pack");

    return pack[pos++];
  };

  for (let i = 0; i < count; i++) {
    const at = pos;
    let b = next();
    const type = (b >> 4) & 7;
    let size = b & 0x0f;

    for (let shift = 16; b & 0x80; shift *= 128) {
      b = next();
      size += (b & 0x7f) * shift;
    }

    const e: Entry = { at, type, size, dataAt: 0, end: 0 };

    if (type === OFS_DELTA) {
      b = next();
      let distance = b & 0x7f;

      while (b & 0x80) {
        b = next();
        distance = (distance + 1) * 128 + (b & 0x7f);
      }

      e.ofsBase = at - distance;
    } else if (type === REF_DELTA) {
      if (pos + 20 > last) throw new PackError("short pack");
      e.refBase = toHex(pack.subarray(pos, pos + 20));
      pos += 20;
    } else if (type < 1 || type > 4) {
      throw new PackError(`object type ${type}`);
    }

    e.dataAt = pos;
    // zlib never makes a stream longer than this (deflateBound), so only that much is handed to inflate.
    const bound = size + (size >> 12) + (size >> 14) + (size >> 25) + 64;
    pos += streamLength(pack.subarray(pos, Math.min(last, pos + bound)));
    e.end = pos;
    entries.push(e);
  }

  return entries;
}

/** How many bytes of `bytes` the zlib stream at its start takes. */
function streamLength(bytes: Uint8Array): number {
  try {
    return inflateSync(bytes, { info: true }).engine.bytesWritten;
  } catch {
    throw new PackError("bad zlib stream");
  }
}

function inflate(bytes: Uint8Array): Uint8Array {
  try {
    return new Uint8Array(inflateSync(bytes));
  } catch {
    throw new PackError("bad zlib stream");
  }
}

/** An OFS_DELTA distance as git writes it. */
function ofsBytes(distance: number): Uint8Array {
  const out = [distance & 0x7f];

  while ((distance = Math.floor(distance / 128)) > 0) {
    distance--;
    out.unshift(0x80 | (distance & 0x7f));
  }

  return Uint8Array.from(out);
}

/** The raw bytes of tree `sha` from the repo, checked against its id; null when it is not a tree there. */
async function treeBytes(sha: string, readTree: ReadTree): Promise<Uint8Array | null> {
  const entries = await readTree(sha);

  if (!entries) return null;
  const tree = await treeObject(entries);

  return tree.sha === sha ? tree.data : null;
}

/** git's delta format: the base's size, the result's size, then copies from the base and inserted bytes. */
function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let pos = 0;

  const byte = () => {
    if (pos >= delta.length) throw new PackError("delta: short");

    return delta[pos++];
  };

  const varint = () => {
    let n = 0;
    let b: number;

    for (let shift = 1; ; shift *= 128) {
      b = byte();
      n += (b & 0x7f) * shift;

      if (!(b & 0x80)) return n;
    }
  };

  if (varint() !== base.length) throw new PackError("delta: base size differs");
  const out = new Uint8Array(varint());
  let o = 0;

  while (pos < delta.length) {
    const op = byte();

    if (op & 0x80) {
      let offset = 0;
      let size = 0;

      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += byte() * 2 ** (8 * i);

      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size += byte() * 2 ** (8 * i);

      if (size === 0) size = 0x10000;

      if (offset + size > base.length || o + size > out.length) throw new PackError("delta: copy out of range");
      out.set(base.subarray(offset, offset + size), o);
      o += size;
    } else if (op > 0) {
      if (pos + op > delta.length || o + op > out.length) throw new PackError("delta: insert out of range");
      out.set(delta.subarray(pos, pos + op), o);
      pos += op;
      o += op;
    } else {
      throw new PackError("delta: opcode 0");
    }
  }

  if (o !== out.length) throw new PackError("delta: result size differs");

  return out;
}
