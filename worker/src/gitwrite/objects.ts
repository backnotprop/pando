// Git object encoding: blobs, trees and commits as git stores them, and
// their SHA-1 ids. Nothing here talks to Artifacts.

export type ObjectType = "commit" | "tree" | "blob";

export interface GitObject {
  type: ObjectType;
  data: Uint8Array;
  sha: string;
}

export interface TreeEntry {
  name: string;
  mode: string; // canonical git mode: 100644, 100755, 120000, 160000, 40000
  hash: string;
}

export interface Signature {
  name: string;
  email: string;
  date?: Date;
}

export const TREE_MODE = "40000";

export const ZERO_SHA = "0000000000000000000000000000000000000000";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const enc = new TextEncoder();

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;

  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;

  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }

  return out;
}

export function toHex(bytes: Uint8Array): string {
  let s = "";

  for (const b of bytes) s += b.toString(16).padStart(2, "0");

  return s;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);

  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

  return out;
}

export async function sha1(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", data));
}

export async function makeObject(type: ObjectType, data: Uint8Array): Promise<GitObject> {
  const header = enc.encode(`${type} ${data.length}\0`);

  return { type, data, sha: toHex(await sha1(concat([header, data]))) };
}

export function blobObject(content: string | Uint8Array): Promise<GitObject> {
  return makeObject("blob", typeof content === "string" ? enc.encode(content) : content);
}

// Git orders tree entries by the bytes of their names, comparing a tree's name
// as if it ended in "/".
export function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  const keyed = entries.map((e) => ({ e, k: enc.encode(e.mode === TREE_MODE ? e.name + "/" : e.name) }));
  keyed.sort((a, b) => {
    const n = Math.min(a.k.length, b.k.length);

    for (let i = 0; i < n; i++) if (a.k[i] !== b.k[i]) return a.k[i] - b.k[i];

    return a.k.length - b.k.length;
  });

  return keyed.map((x) => x.e);
}

export function treeObject(entries: TreeEntry[]): Promise<GitObject> {
  const parts: Uint8Array[] = [];

  for (const e of sortEntries(entries)) {
    parts.push(enc.encode(`${e.mode} ${e.name}\0`), fromHex(e.hash));
  }

  return makeObject("tree", concat(parts));
}

function signatureLine(s: Signature): string {
  const seconds = Math.floor((s.date ?? new Date()).getTime() / 1000);

  return `${s.name} <${s.email}> ${seconds} +0000`;
}

export function commitObject(c: {
  tree: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  message: string;
}): Promise<GitObject> {
  let text = `tree ${c.tree}\n`;

  for (const p of c.parents) text += `parent ${p}\n`;
  text += `author ${signatureLine(c.author)}\n`;
  text += `committer ${signatureLine(c.committer)}\n\n`;
  text += c.message.endsWith("\n") ? c.message : c.message + "\n";

  return makeObject("commit", enc.encode(text));
}
