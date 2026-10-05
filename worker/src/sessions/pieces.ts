// A session's pieces in R2 (the BLOBS bucket, no bucket of its own): each piece as sent, after the server's own
// secret scan, gzipped, under sessions/<monorepo id>/<session id>/. A piece's key carries its start and a random
// tail, so a refused or repeated upload never overwrites a stored piece. Deleting a session deletes the prefix.
import { HttpError } from "../http";
import { PIECE_MAX } from "./parse";

/** Pando's mark for a removed secret, on the machine and here; no agent writes it. Counted per session. */
export const REDACTED = "[pando:redacted]";

/**
 * The server's second look (PROPOSAL.md L1): fixed token prefixes and private key blocks. The machine already ran
 * betterleaks and Pando's own checks; this catches what slipped past them. Inside JSON strings: no quotes matched.
 */
const SECRETS = [
  /pando_[a-f0-9]{40}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /\b[sr]k_live_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[^"]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** The piece with every match replaced by the mark, and how many marks it now holds (the machine's included). */
export interface Scanned {
  text: string;
  redactions: number;
}

export function scan(text: string): Scanned {
  let out = text;

  for (const re of SECRETS) out = out.replace(re, REDACTED);

  return { text: out, redactions: out.split(REDACTED).length - 1 };
}

export function piecePrefix(monorepoId: string, sessionId: string): string {
  return `sessions/${monorepoId}/${sessionId}/`;
}

export function pieceKey(monorepoId: string, sessionId: string, at: number): string {
  const tail = crypto.getRandomValues(new Uint8Array(6)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");

  return `${piecePrefix(monorepoId, sessionId)}${String(at).padStart(16, "0")}-${tail}.ndjson.gz`;
}

async function readAll(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const chunk of stream) {
    size += chunk.byteLength;

    if (size > max) throw new HttpError(413, "piece_too_large", `a piece is at most ${max} bytes of lines; send the rest as the next piece`);
    chunks.push(chunk);
  }

  const out = new Uint8Array(size);
  let at = 0;

  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }

  return out;
}

/** A request's piece: its lines as text, gunzipped when sent gzipped, refused over PIECE_MAX. */
export async function pieceText(body: ReadableStream<Uint8Array> | null, gzip: boolean): Promise<string> {
  if (!body) throw new HttpError(400, "bad_request", "send the piece's lines as the body");
  const plain = gzip ? body.pipeThrough(new DecompressionStream("gzip")) : body;

  const bytes = await readAll(plain, PIECE_MAX).catch((err) => {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "bad_request", "the body is not gzip");
  });

  return new TextDecoder().decode(bytes);
}

export async function putPiece(bucket: R2Bucket, key: string, text: string): Promise<void> {
  const gz = await readAll(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")), Number.MAX_SAFE_INTEGER);
  await bucket.put(key, gz, { httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" } });
}

/** A stored piece's lines, or null when it is gone (a delete raced the read). */
export async function getPiece(bucket: R2Bucket, key: string): Promise<string | null> {
  const obj = await bucket.get(key);

  if (!obj) return null;

  return new Response(obj.body.pipeThrough(new DecompressionStream("gzip"))).text();
}

/** Every object under a prefix, deleted a page at a time. */
export async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });

    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
