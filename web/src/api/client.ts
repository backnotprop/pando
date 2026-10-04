// The one way the web talks to the Worker: fetch on the same origin (the
// session cookie rides along), decode the body with its Schema from
// @pando/contract, and turn a failure into the contract's tagged errors, which
// TanStack Query hands to the screens. No Effect runtime: Result only.
import { type ActivityFrame, type ApiFailure, type MonorepoFeedFrame, BadResponse, decodeActivityFrame, decodeMonorepoFeedFrame, decodeResponse, ErrorBody, failureOf, NotFound, Unauthorized } from "@pando/contract";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";

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
  // A 204 has no body: its schema is Schema.Null.
  const out = decodeResponse(schema)(res.status === 204 ? null : await res.json());

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

/** A write a route names (POST, PATCH or DELETE), with an optional JSON body; a 204 decodes as null. */
export async function write<A, I>(route: { method: "POST" | "PATCH" | "DELETE"; path: string; response: Schema.Codec<A, I> }, body?: Record<string, string>): Promise<A> {
  const headers = new Headers({ accept: "application/json" });

  if (body) headers.set("content-type", "application/json");
  const res = await send(route.path, { method: route.method, headers, body: body ? JSON.stringify(body) : undefined });

  return decoded(route.response, res, route.path);
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

/** A file's bytes as text, or null when they are binary (a NUL in the first 8,000 bytes, git's test). */
export interface FileText {
  text: string | null;
}

export async function getText(path: string): Promise<FileText> {
  const bytes = new Uint8Array(await (await send(path, {})).arrayBuffer());

  return { text: bytes.subarray(0, 8000).includes(0) ? null : new TextDecoder().decode(bytes) };
}

/** A frame from the person's socket, or null for the text `pong`, a frame this build does not know, or anything malformed. */
export const decodeFrame = (data: string): ActivityFrame | null => Option.getOrNull(decodeActivityFrame(data));

/** A frame from a monorepo's own socket, or null for `pong` and anything this build does not read. */
export const decodeMonorepoFrame = (data: string): MonorepoFeedFrame | null => Option.getOrNull(decodeMonorepoFeedFrame(data));
