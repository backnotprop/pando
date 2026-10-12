// The one way the web talks to the Worker: fetch on the same origin (the
// session cookie rides along), decode the body with its Schema from
// @pando/contract, and turn a failure into the contract's tagged errors, which
// TanStack Query hands to the screens. No Effect runtime: Result only.
import { type ActivityFrame, type ApiFailure, type MonorepoFeedFrame, BadResponse, decodeActivityFrame, decodeMonorepoFeedFrame, decodeResponse, ErrorBody, failureOf, NotFound, Unauthorized } from "@pando/contract";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type { JsonBody } from "./json";

declare module "@tanstack/react-query" {
  interface Register {
    defaultError: ApiFailure;
  }
}

export type { ApiFailure };

export const isSignedOut = (error: ApiFailure | Error): boolean => error instanceof Unauthorized;

export const isMissing = (error: ApiFailure | Error): boolean => error instanceof NotFound;

/** A response this build cannot read: the server was updated while the tab was open. */
export const isOutdated = (error: ApiFailure | Error): boolean => error instanceof BadResponse;

const decodeError = decodeResponse(ErrorBody);

async function failure(res: Response, path: string): Promise<ApiFailure> {
  const body = decodeError(await res.json().catch(() => null));

  return failureOf(res.status, path, Result.isSuccess(body) ? body.success : null);
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(path, { credentials: "same-origin", ...init });

  if (res.ok) return res;

  throw await failure(res, path);
}

async function decoded<A, I>(schema: Schema.Codec<A, I>, res: Response, path: string): Promise<A> {
  const out = decodeResponse(schema)(await res.json());

  if (Result.isFailure(out)) throw new BadResponse({ status: res.status, path, message: out.failure.message });

  return out.success;
}

/** GET a JSON record. */
export async function get<A, I>(schema: Schema.Codec<A, I>, path: string): Promise<A> {
  return decoded(schema, await send(path, { headers: { accept: "application/json" } }), path);
}

/** POST JSON; the browser adds Origin, which the Worker checks on writes. */
export async function post<A, I>(schema: Schema.Codec<A, I>, path: string, body: Record<string, string | number>): Promise<A> {
  const res = await send(path, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return decoded(schema, res, path);
}

export type { JsonBody, JsonValue } from "./json";

/**
 * A write a route names (POST, PATCH, PUT or DELETE), with an optional JSON
 * body, and its decoded answer. `idempotencyKey` makes a retried create
 * answer the first one (the server keeps the key with what it made).
 */
export async function write<A, I>(
  route: { method: "POST" | "PATCH" | "PUT" | "DELETE"; path: string; response: Schema.Codec<A, I> },
  body?: JsonBody,
  idempotencyKey?: string,
): Promise<A> {
  const headers = new Headers({ accept: "application/json" });

  if (body) headers.set("content-type", "application/json");

  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  const res = await send(route.path, { method: route.method, headers, body: body ? JSON.stringify(body) : undefined });

  return decoded(route.response, res, route.path);
}

/** A multipart POST a route names (an upload): the form as the browser encodes it, and its decoded answer. */
export async function sendForm<A, I>(route: { method: "POST"; path: string; response: Schema.Codec<A, I> }, form: FormData): Promise<A> {
  const res = await send(route.path, { method: route.method, headers: { accept: "application/json" }, body: form });

  return decoded(route.response, res, route.path);
}

/** A DELETE a route names: it answers 204, no body. */
export async function remove(route: { method: "DELETE"; path: string }): Promise<void> {
  await send(route.path, { method: route.method, headers: { accept: "application/json" } });
}

/** A PUT whose answer is 204 (no body): a list replaced whole. */
export async function put(route: { method: "PUT"; path: string }, body: JsonBody): Promise<void> {
  await send(route.path, { method: route.method, headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** POST JSON where some refusals are answers, not failures (a merge's 409 and 412): either decoded body. */
export async function postOrRefused<A, I, B, J>(
  ok: Schema.Codec<A, I>,
  refused: Schema.Codec<B, J>,
  path: string,
  body: Record<string, string>,
  refusals: readonly number[],
): Promise<{ ok: A; refused: null } | { ok: null; refused: B }> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (refusals.includes(res.status)) return { ok: null, refused: await decoded(refused, res, path) };

  if (!res.ok) throw await failure(res, path);

  return { ok: await decoded(ok, res, path), refused: null };
}

/** The most a file page reads; past it the page offers Raw only (owner board: code view limits). */
export const MAX_SHOWN = 10 * 1024 * 1024;

/**
 * A file's bytes as text, and how many bytes it has. `text` is null when they
 * are binary (a NUL in the first 8,000 bytes, git's test) or over MAX_SHOWN,
 * which is not read past (then `size` is only how far it was read).
 */
export interface FileText {
  text: string | null;
  size: number;
}

export async function getText(path: string): Promise<FileText> {
  const reader = (await send(path, {})).body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (let part = await reader?.read(); part && !part.done; part = await reader?.read()) {
    size += part.value.byteLength;

    if (size > MAX_SHOWN) {
      await reader?.cancel();

      return { text: null, size };
    }

    chunks.push(part.value);
  }

  const bytes = new Uint8Array(size);
  let at = 0;

  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }

  return { text: bytes.subarray(0, 8000).includes(0) ? null : new TextDecoder().decode(bytes), size };
}

/**
 * An NDJSON answer, read as it arrives: each network chunk's complete lines,
 * decoded (a line this build cannot read is skipped), yielded together, so a
 * reader can draw a large answer while the rest is still coming.
 */
export async function* getLines<A>(path: string, decode: (line: string) => Option.Option<A>, signal?: AbortSignal): AsyncGenerator<A[]> {
  const reader = (await send(path, { signal })).body?.pipeThrough(new TextDecoderStream()).getReader();
  // The start of a line not yet ended, in pieces (a long line, a large file's patch, spans many chunks).
  let rest: string[] = [];

  for (let part = await reader?.read(); part && !part.done; part = await reader?.read()) {
    const end = part.value.lastIndexOf("\n");

    if (end === -1) {
      rest.push(part.value);
      continue;
    }

    const text = rest.join("") + part.value.slice(0, end);
    const lines = text.split("\n").flatMap((line) => (line ? Option.toArray(decode(line)) : []));

    rest = [part.value.slice(end + 1)];

    if (lines.length) yield lines;
  }

  const tail = rest.join("");
  const last = tail.trim() ? Option.toArray(decode(tail)) : [];

  if (last.length) yield last;
}

/** A frame from the person's socket, or null for the text `pong`, a frame this build does not know, or anything malformed. */
export const decodeFrame = (data: string): ActivityFrame | null => Option.getOrNull(decodeActivityFrame(data));

/** A frame from a monorepo's own socket, or null for `pong` and anything this build does not read. */
export const decodeMonorepoFrame = (data: string): MonorepoFeedFrame | null => Option.getOrNull(decodeMonorepoFeedFrame(data));
