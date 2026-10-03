// Bytes helpers with Web APIs only (no node: imports).

export function toBase64(bytes: Uint8Array): string {
  let s = "";

  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(s);
}

// fromBase64 returns null for text that is not base64.
export function fromBase64(b64: string): Uint8Array | null {
  let s: string;

  try {
    s = atob(b64);
  } catch {
    return null;
  }

  const out = new Uint8Array(s.length);

  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);

  return out;
}

// gitBlobSha is git's object id for a blob: SHA-1 of "blob <size>\0<bytes>".
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head, 0);
  all.set(bytes, head.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", all));

  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function exactBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.slice().buffer;
}
