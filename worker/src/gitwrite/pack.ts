// A minimal PACK v2: whole objects, zlib-deflated, no deltas. Git accepts it
// in a push as long as every object it points to is in the pack or already
// in the repo.
import { concat, sha1, type GitObject } from "./objects";

const TYPE_CODE = { commit: 1, tree: 2, blob: 3 } as const;

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  // "deflate" in the Compression Streams standard is the zlib format git uses.
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16);

  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size = Math.floor(size / 128);
  }

  bytes.push(b);

  return new Uint8Array(bytes);
}

export async function buildPack(objects: GitObject[]): Promise<Uint8Array> {
  const header = new Uint8Array(12);
  header.set([0x50, 0x41, 0x43, 0x4b]); // "PACK"
  const view = new DataView(header.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  const parts: Uint8Array[] = [header];

  for (const o of objects) {
    parts.push(objectHeader(TYPE_CODE[o.type], o.data.length), await deflate(o.data));
  }

  const body = concat(parts);

  return concat([body, await sha1(body)]);
}
