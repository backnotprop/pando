// Bytes to R2 and through SHA-256 at once, for release files and artifacts.

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Put `size` bytes at `key` while hashing them; answers their SHA-256 (hex). R2 needs the length up front (FixedLengthStream). */
export async function putHashed(bucket: R2Bucket, key: string, body: ReadableStream, size: number, contentType: string): Promise<string> {
  const [toR2, toHash] = body.tee();
  const digest = new crypto.DigestStream("SHA-256");
  await Promise.all([bucket.put(key, toR2.pipeThrough(new FixedLengthStream(size)), { httpMetadata: { contentType } }), toHash.pipeTo(digest)]);

  return hex(await digest.digest);
}

/** Delete every R2 object under a prefix. */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  for (let more = true; more; ) {
    const listed = await bucket.list({ prefix, limit: 1000 });

    if (listed.objects.length) await bucket.delete(listed.objects.map((o) => o.key));
    more = listed.truncated;
  }
}

/** Bytes already in memory (an artifact's files, from a multipart body): hashed, then put. Answers their SHA-256 (hex). */
export async function putBytes(bucket: R2Bucket, key: string, bytes: ArrayBuffer, contentType: string): Promise<string> {
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  await bucket.put(key, bytes, { httpMetadata: { contentType }, sha256 });

  return sha256;
}
