// Reading a session's stored pieces back: a page of its conversation (parsed on read, a few pieces at a time), a
// removed turn (its lines cut from the stored pieces, a mark left in their place), a reindex (every number rebuilt
// from the pieces), and a delete (the pieces gone from R2 at once).
import type { Env } from "../env";
import { HttpError, now } from "../http";
import { withRepo } from "../monorepo/artifacts";
import { changedFiles } from "../monorepo/diff";
import { commitReader } from "../monorepo/graph";
import { monorepoStub } from "../monorepo/session";
import { unwrap } from "./append";
import { linesOf, parsePiece, type Carry, type Entry } from "./parse";
import { deletePrefix, getPiece, pieceKey, piecePrefix, putPiece, scan } from "./pieces";
import type { PieceReread, PieceRow, RewrittenPiece, SessionSource, SessionView } from "./store";

/** Bytes of lines a page of the conversation reads, at least one piece (a piece is at most 8 MB). */
export const PAGE_BYTES = 2_000_000;

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
    await putPiece(env.BLOBS, key, body);
    const bytes = new TextEncoder().encode(body).byteLength;
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

/** One file a session's commits changed, in its repo (`repo_path`: the repo's folder in the repository). */
export interface SessionFile {
  repo: string;
  repo_path: string;
  path: string;
}

/** At most this many of a session's commits are read for their files: one Artifacts walk each. */
export const FILES_COMMITS_MAX = 50;

/** The files in a session's commits (DETERMINISM.md: exact, read from git), each commit against its first parent. */
export async function sessionFiles(env: Env, monorepoId: string, id: string): Promise<{ files: SessionFile[] }> {
  const stub = monorepoStub(env, monorepoId);
  const view = unwrap(await stub.sessionGet(id));

  if (view.state === "deleted") return { files: [] };
  const byRepo = new Map<string, string[]>();

  for (const c of view.commits.slice(0, FILES_COMMITS_MAX)) byRepo.set(c.repo, [...(byRepo.get(c.repo) ?? []), c.sha]);
  const out = new Map<string, SessionFile>();

  for (const [name, shas] of byRepo) {
    const r = await stub.getRepo(name);

    if (!r) continue;
    await withRepo(env, r.artifacts_name, async (repo) => {
      const read = commitReader(repo);

      for (const sha of shas) {
        const c = await read(sha);

        if (!c.parents[0]) continue;

        for (const f of await changedFiles(repo, (await read(c.parents[0])).tree, c.tree)) out.set(`${name}\n${f.path}`, { repo: name, repo_path: r.path, path: f.path });
      }
    });
  }

  return { files: [...out.values()].sort((a, b) => a.repo_path.localeCompare(b.repo_path) || a.path.localeCompare(b.path)) };
}

/** Delete many at once (Settings): the index first, then each session's pieces from R2. */
export async function deleteSessions(env: Env, monorepoId: string, login: string, owner: boolean, everyone: boolean, repo: string | null, before: string | null): Promise<{ deleted: number }> {
  const ids = unwrap(await monorepoStub(env, monorepoId).sessionDeleteMany(login, owner, everyone, repo, before));

  for (const id of ids) await deletePrefix(env.BLOBS, piecePrefix(monorepoId, id));

  return { deleted: ids.length };
}
