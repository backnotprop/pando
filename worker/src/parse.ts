// Guards for untrusted input, shared by every lane: request bodies, WebSocket
// messages, TOML, D1 rows, stored JSON and thrown errors. Decode at the
// boundary with these, then work with the domain type. The lint allows
// `typeof` only inside named type guards like these (pando-ops, 2026-10-03);
// never disguise the check elsewhere.

/** A JSON value: what JSON.parse and request.json() produce. */
export type Json = null | boolean | number | string | Json[] | JsonObject;

/** A JSON object. A key the sender left out reads as undefined. */
export interface JsonObject {
  readonly [key: string]: Json | undefined;
}

/** A string. */
export function isText(v: unknown): v is string {
  return typeof v === "string";
}

/** A whole number, negative ones included, within 2^53 - 1 either way (an exit status can be -1). */
export function isInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

/** A whole number from 0 to 2^53 - 1. */
export function isWholeNumber(v: unknown): v is number {
  return Number.isSafeInteger(v) && typeof v === "number" && v >= 0;
}

/**
 * A JSON object (not null, not an array). It takes a Json value, from
 * JSON.parse, parseJson, request.json<Json>() or a WebSocket text frame,
 * because only then are its values JSON by construction.
 */
export function isRecord(v: Json | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One of a closed list of words, such as a stored column's value read back from SQL. */
export function isOneOf<T extends string>(list: readonly T[], v: string | null | undefined): v is T {
  return list.some((x) => x === v);
}

/** A list of strings. */
export function isTextList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isText);
}

/** A thrown value with a string `code` (Artifacts and other binding errors carry one). */
export function hasCode(v: unknown): v is { code: string } {
  return typeof v === "object" && v !== null && "code" in v && typeof v.code === "string";
}

/** Parse JSON text; null when it is not JSON (the JSON text `null` also reads as null). */
export function parseJson(text: string): Json | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
