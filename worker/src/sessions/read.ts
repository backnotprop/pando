// Reading a session's stored pieces back: a page of its conversation (parsed on read, a few pieces at a time), a
// removed turn (its lines cut from the stored pieces, a mark left in their place), a reindex (every number rebuilt
// from the pieces), and a delete (the pieces gone from R2 at once).
import type { Env } from "../env";
import { HttpError, now } from "../http";
import { monorepoStub } from "../monorepo/session";
import { unwrap } from "./append";
import { linesOf, parsePiece, type Carry, type Entry } from "./parse";
import { deletePrefix, getPiece, pieceKey, piecePrefix, putPiece, scan } from "./pieces";
import type { PieceReread, PieceRow, RewrittenPiece, SessionSource, SessionView } from "./store";

/** Stored (gzipped) bytes a page of the conversation reads, at least one piece: about 2 to 5 MB of lines. */
export const PAGE_BYTES = 512 * 1024;

/** A page of the conversation; `next_cursor` is the next piece's start. */
export interface EntryPage {
  entries: Entry[];
  next_cursor: number | null;
}

interface Removal {
  prompt: number;
  by: string;
  at: string;
}

/** A piece's entries with prompt numbers, a mark where each removed prompt was (its number kept, owner's rule). */
function numbered(p: PieceRow, entries: Entry[], removals: Removal[]): Entry[] {
  const mine = new Map<number, Removal>();

  for (const r of removals) if (r.prompt >= p.prompt_first && r.prompt < p.prompt_first + p.prompts + p.removed) mine.set(r.prompt, r);
  const out: Entry[] = [];
  let n = p.prompt_first;

  const marks = () => {
    for (let r = mine.get(n); r; r = mine.get(n)) {
      out.push({ id: `${p.at}.removed${n}`, at: r.at, kind: "removed", text: null, prompt: n, tool: null, input: null, result: null, ok: null, by: r.by });
      mine.delete(n);
      n++;
    }
  };

  for (const e of entries) {
    if (e.kind === "prompt") {
      marks();
      out.push({ ...e, prompt: n++ });
    } else {
      out.push(e);
    }
  }

  marks();

  return out;
}

async function pieceEntries(env: Env, src: SessionSource, p: PieceRow, removals: Removal[]): Promise<Entry[]> {
  const text = await getPiece(env.BLOBS, p.key);

  if (text === null) throw new HttpError(410, "session_deleted", "the session was deleted while it was read");

  return numbered(p, parsePiece(src.program, text, String(p.at), src.agent_id, { model: p.carry_model, at: p.carry_at }).entries, removals);
}

/** A page of the conversation from the piece starting at `from` (0: the beginning); `next_cursor` continues it. */
export async function readEntries(env: Env, monorepoId: string, id: string, from: number): Promise<EntryPage> {
  const stub = monorepoStub(env, monorepoId);
  const src = unwrap(await stub.sessionSource(id));
  const page = unwrap(await stub.sessionPieces(id, from, PAGE_BYTES));
  const removals = unwrap(await stub.sessionRemovals(id));
  const entries: Entry[] = [];

  for (const p of page.pieces) entries.push(...(await pieceEntries(env, src, p, removals)));

  return { entries, next_cursor: page.next };
}

/**
 * Remove prompt `n`'s turn: every line from that prompt up to the next one (or up to now, when it is the last), cut
 * from the stored pieces, which are written again; the mark stays with who and when. Lines are cut by their own
 * time, the same for every agent.
 */
export async function removeTurn(env: Env, monorepoId: string, id: string, n: number, login: string, owner: boolean): Promise<SessionView> {
  const stub = monorepoStub(env, monorepoId);
  unwrap(await stub.sessionMayRemove(id, n, login, owner));
  const src = unwrap(await stub.sessionSource(id));
  const pieces = unwrap(await stub.sessionAllPieces(id));
  const removals = unwrap(await stub.sessionRemovals(id));
  const home = pieces.find((p) => n >= p.prompt_first && n < p.prompt_first + p.prompts + p.removed);

  if (!home) throw new HttpError(404, "not_found", `session ${id} has no prompt ${n}`);
  let fromAt: string | null = null;
  let toAt: string | null = null;

  // The prompt's time, then the next remaining prompt's, reading on from its piece.
  for (const p of pieces.filter((x) => x.at >= home.at)) {
    for (const e of await pieceEntries(env, src, p, removals)) {
      if (e.kind !== "prompt" || e.prompt === null || e.prompt < n) continue;

      if (e.prompt === n) fromAt = e.at;
      else if (fromAt !== null) toAt = e.at;

      if (toAt !== null) break;
    }

    if (toAt !== null || fromAt === null) break;
  }

  if (fromAt === null) throw new HttpError(404, "not_found", `session ${id} has no prompt ${n}`);
  const from = fromAt;
  const to = toAt ?? now();
  const rewritten: RewrittenPiece[] = [];

  for (const p of pieces) {
    if ((p.last_at !== null && p.last_at < from) || (p.first_at !== null && p.first_at >= to)) continue;
    const text = await getPiece(env.BLOBS, p.key);

    if (text === null) continue;
    const kept = linesOf(src.program, text, p.carry_at).filter((l) => l.at === null || l.at < from || l.at >= to);
    const body = kept.map((l) => `${l.raw}\n`).join("");
    const facts = parsePiece(src.program, body, String(p.at), src.agent_id, { model: p.carry_model, at: p.carry_at }).facts;
    const key = pieceKey(monorepoId, id, p.at);
    const bytes = await putPiece(env.BLOBS, key, body);
    rewritten.push({ at: p.at, record: { key, bytes, redactions: scan(body).redactions, facts } });
  }

  const out = await stub.sessionRemoveTurn(id, { prompt: n, from_at: from, to_at: to, piece: home.at }, rewritten, login);

  if (!out.ok) {
    await env.BLOBS.delete(rewritten.map((r) => r.record.key));

    return unwrap(out);
  }

  await env.BLOBS.delete(out.value.old);

  return out.value.view;
}

/** Read every stored piece again and rebuild the session's numbers: how a parser fix reaches stored sessions. */
export async function reindex(env: Env, monorepoId: string, id: string): Promise<SessionView> {
  const stub = monorepoStub(env, monorepoId);
  const src = unwrap(await stub.sessionSource(id));
  const read: PieceReread[] = [];
  let carry: Carry = { model: null, at: null };

  for (const p of unwrap(await stub.sessionAllPieces(id))) {
    const text = await getPiece(env.BLOBS, p.key);

    if (text === null) throw new HttpError(410, "session_deleted", "the session was deleted while it was read");
    const facts = parsePiece(src.program, text, String(p.at), src.agent_id, carry).facts;
    read.push({ at: p.at, facts, redactions: scan(text).redactions });
    carry = { model: facts.model_after ?? carry.model, at: facts.last_at ?? carry.at };
  }

  return unwrap(await stub.sessionReindex(id, read));
}

/** Delete at once: the index keeps a stub (who, when); every stored piece goes from R2 now. */
export async function deleteSession(env: Env, monorepoId: string, id: string, login: string, owner: boolean) {
  const view = unwrap(await monorepoStub(env, monorepoId).sessionDelete(id, login, owner));
  await deletePrefix(env.BLOBS, piecePrefix(monorepoId, id));

  return view;
}
