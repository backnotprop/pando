// Large files and binaries of the meta layer: their bytes live in R2 under
// their SHA-256, and the meta layer holds a Git LFS pointer (formats.md,
// section 5). Routes, served by the Worker without the object:
//
//   PUT  /v1/monorepos/{monorepo}/meta/blobs/{sha256}   upload (R2 checks the hash)
//   GET  /v1/monorepos/{monorepo}/meta/blobs/{sha256}   download
//   HEAD /v1/monorepos/{monorepo}/meta/blobs/{sha256}   is it there
export const MAX_BLOB = 100 * 1024 * 1024; // the largest request body a Worker takes
const OID = /^[0-9a-f]{64}$/;
const POINTER =
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (0|[1-9][0-9]{0,15})\n$/;

export interface Pointer {
  oid: string;
  size: number;
}

// parsePointer returns the pointer when the bytes are exactly one.
export function parsePointer(bytes: Uint8Array): Pointer | null {
  if (bytes.length >= 1024) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  const m = text.match(POINTER);
  return m ? { oid: m[1], size: Number(m[2]) } : null;
}

export function blobKey(monorepo: string, oid: string): string {
  return `meta/${monorepo}/${oid}`;
}

function fail(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function handleBlob(request: Request, bucket: R2Bucket | undefined, monorepo: string, oid: string): Promise<Response> {
  if (!bucket) return fail(501, "no_blob_store", "this Worker has no R2 binding for large files");
  if (!OID.test(oid)) return fail(400, "invalid_input", "a blob is named by its SHA-256, 64 lowercase hex characters");
  const key = blobKey(monorepo, oid);
  switch (request.method) {
    case "HEAD": {
      const head = await bucket.head(key);
      return new Response(null, { status: head ? 200 : 404, headers: head ? { "content-length": String(head.size) } : {} });
    }
    case "GET": {
      const obj = await bucket.get(key);
      if (!obj) return fail(404, "not_found", "no such blob");
      return new Response(obj.body, {
        headers: { "content-type": "application/octet-stream", "content-length": String(obj.size), "x-pando-oid": oid },
      });
    }
    case "PUT": {
      const length = Number(request.headers.get("content-length") ?? NaN);
      if (!Number.isSafeInteger(length) || length < 0) return fail(411, "length_required", "send Content-Length");
      if (length > MAX_BLOB) return fail(413, "too_large", "a meta layer file is at most 100 MB");
      const existing = await bucket.head(key);
      if (existing) {
        await request.body?.cancel();
        return Response.json({ oid, size: existing.size, existed: true });
      }
      try {
        const obj = await bucket.put(key, request.body, { sha256: oid });
        return Response.json({ oid, size: obj?.size ?? length, existed: false }, { status: 201 });
      } catch (e) {
        return fail(400, "bad_sha", `the bytes do not match ${oid}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  return fail(405, "method_not_allowed", "use PUT, GET or HEAD");
}
