// Appending a piece to a session: the one way lines get in, for `pando sync` (through the route) and for a writer
// inside Pando (the Cloudflare agents lane) alike. The Worker does the slow part (scan, parse, R2) outside the
// monorepo object; the object takes the piece only at the session's current end, so a resend after a broken
// upload either fits or is refused with the end, and nothing is stored twice.
//
//   appendPiece(env, monorepoId, { login, machine }, { session, at, next, start, lines })
//
// `at` and `next` are the sender's own cursor: a byte offset in the agent's file, the last row read for OpenCode, or
// any number a server-side writer grows. `lines` are whole lines (each ends with "\n"), at most PIECE_MAX bytes.
import type { Env } from "../env";
import { HttpError } from "../http";
import { monorepoStub } from "../monorepo/session";
import type { Outcome } from "../monorepo/types";
import { sessionIdFor } from "./ids";
import { parsePiece, PIECE_MAX } from "./parse";
import { pieceKey, putPiece, scan } from "./pieces";
import type { Sender, SessionStart, SessionView } from "./store";
import { isExcluded } from "./user-routes";

export interface PieceInput {
  session: string;
  at: number;
  next: number;
  start: SessionStart;
  lines: string;
}

export function unwrap<T>(o: Outcome<T>): T {
  if (o.ok) return o.value;
  throw new HttpError(o.status, o.code, o.message, o.extra ?? {});
}

export async function appendPiece(env: Env, monorepoId: string, by: Sender, input: PieceInput): Promise<SessionView> {
  const { session, at, next, start } = input;

  if ((await sessionIdFor(start.program, start.agent_id)) !== session) throw new HttpError(400, "bad_session_id", `session ${session} is not ${start.program}'s id for that agent session`);

  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(next) || at < 0 || next <= at) throw new HttpError(400, "bad_request", "at and next: whole numbers, next after at");

  // Empty is allowed: lines the machine read and did not keep (all reasoning) still move the end on.
  if (input.lines !== "" && !input.lines.endsWith("\n")) throw new HttpError(400, "bad_request", "a piece is whole lines, each ending with a newline");

  if (input.lines.length > PIECE_MAX) throw new HttpError(413, "piece_too_large", `a piece is at most ${PIECE_MAX} bytes of lines`);

  if (await isExcluded(env.ACCOUNTS_DB, by.login, monorepoId, start.repo)) throw new HttpError(403, "sessions_excluded", `${by.login} does not record sessions here`);
  const stub = monorepoStub(env, monorepoId);
  const end = unwrap(await stub.sessionEnd(session, by.login));

  // Refused before any work: the sender resumes from the server's end.
  if (end.end !== at) throw new HttpError(409, "not_at_end", `the session ends at ${end.end}; send the piece that starts there`, { end: end.end });
  const { text, redactions } = scan(input.lines);
  const parsed = parsePiece(start.program, text, String(at), start.agent_id, { model: end.carry_model, at: end.carry_at });
  let parent = start.parent;

  // A Codex subagent names its parent thread in its first line; the parent's id is derived like any session's.
  if (!end.exists && !parent && start.program === "codex" && parsed.facts.parent_agent_id) parent = await sessionIdFor("codex", parsed.facts.parent_agent_id);
  const key = pieceKey(monorepoId, session, at);
  await putPiece(env.BLOBS, key, text);
  const bytes = new TextEncoder().encode(text).byteLength;
  const out = await stub.sessionAppend(session, at, next, { ...start, parent }, by, { key, bytes, redactions, facts: parsed.facts });

  if (!out.ok) await env.BLOBS.delete(key);

  return unwrap(out);
}
