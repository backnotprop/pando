// The account-wide activity feed (C25): the shapes and pure rules shared by
// the monorepo object's side (out.ts), the per-person FeedObject (object.ts),
// the fan-out (consumer.ts: the FeedDrain entrypoint and the pando-feed queue
// consumer) and the routes (routes.ts).
//
// The design is the addendum at the end of
// research/plans/architecture-2026-10-03/ARCHITECTURE.md, with the delivery
// of C25-LIVE-HOME.md: a FeedObject per person; fan-out on write for
// monorepos of FANOUT_MAX members or fewer (each monorepo object's outbox,
// drained by RPC to FeedDrain); fan-in on read for larger ones; a coalesced
// summary line per monorepo; the display key (at, monorepo_id, seq).
//
// Fields (one meaning across the API): `monorepo` is the owner/name label,
// `monorepo_id` the permanent id. Keys, cursors and stored rows use the id;
// the label is added when a line is sent or read. Queue messages are internal
// and their `monorepo` is the id.

import { isRecord, isText, isWholeNumber, type Json } from "../parse";

/** Monorepos with this many members or fewer copy their events into members' feeds (an owner limit). */
export const FANOUT_MAX = 100;

/** A new member's feed gets this many of the monorepo's latest events (an owner limit). */
export const BACKFILL = 500;

/** A feed keeps this many days of events, and at most WINDOW_MAX of them (owner limits). */
export const WINDOW_DAYS = 7;

export const WINDOW_MAX = 1_000_000;

/** Monorepos read from their own logs for one page, beyond which the page names them in `skipped` (an owner limit). */
export const LOGS_MAX = 20;

/** Events per page. */
export const PAGE_DEFAULT = 50;

export const PAGE_MAX = 200;

/** Frames a reconnecting socket gets before it is told to resync. */
export const REPLAY_MAX = 500;

/** A monorepo's summary line is sent at most this often (small, large). */
export const TICK_SMALL_MS = 10_000;

export const TICK_LARGE_MS = 60_000;

/** Worktree ids one follower's hello may carry. */
export const HELLO_WORKTREES_MAX = 1_000;

/** Monorepos one needs-you call asks (most recently active first), beyond which they are named in `skipped`. */
export const NEEDS_MONOREPOS_MAX = 50;

/** Member lists up to this size travel in the queue message; larger ones are read from the monorepo object. */
export const MEMBERS_INLINE_MAX = 1_000;

/**
 * The kinds the home's log shows. Cache-sync kinds (branch.updated,
 * default_head.updated, machine.connected, machine.disconnected) stay on the
 * per-monorepo stream. `status` counts only when a check's state changes,
 * `worktree.reported` only for a new worktree, `meta.saved` not for files a
 * merge brought in.
 */
export const ACTIVITY_KINDS = [
  "push", "branch.opened", "branch.deleted", "merged", "review", "status", "worktree.reported", "worktree.removed", "meta.saved",
] as const;

/**
 * One line of the activity log. No agent field: the product shows people,
 * machines and worktrees (owner ruling). `monorepo_id` keys the line (never
 * moved by a rename); `monorepo` is its owner/name, added when the line is
 * sent or read.
 */
export interface FeedEvent {
  monorepo_id: string;
  monorepo: string;
  seq: number;
  at: string;
  kind: string;
  /** The repo's name in URLs, and its path (`projects/web`; `.` for the meta layer and a plain repo). */
  repo: string | null;
  repo_path: string | null;
  branch: string | null;
  /** The person (a login), and the machine (the credential's name). */
  actor: string | null;
  machine: string | null;
  /** Per kind: push {commits, head_title, head}; status {context, state, duration_s, app}; worktree.* {path}; and so on. */
  summary: LineSummary | null;
}

// ── A line's summary, per kind (the shapes packages/contract/src/feed.ts declares) ──

/** push, branch.opened. `commits` and `head_title` arrive a moment after the push (the facts job). */
export interface PushSummary {
  head: string | null;
  before: string | null;
  commits: number | null;
  head_title: string | null;
  /** A first push of main with more than 250 commits. */
  commits_more?: boolean;
}

/** What the facts job adds to a push's summary. */
export interface PushNumbers {
  commits: number | null;
  head_title: string | null;
  commits_more?: boolean;
}

export interface BranchDeletedSummary {
  before: string | null;
}

export interface MergedSummary {
  merge_commit: string | null;
  forced: boolean | null;
  /** The branch's title. */
  title: string | null;
  head: string | null;
}

export interface ReviewSummary {
  verdict: string | null;
  comments: number;
  head: string | null;
}

export interface StatusSummary {
  context: string;
  state: string;
  description: string | null;
  target_url: string | null;
  sha: string;
  duration_s: number | null;
  /** The CI service that reported it; null when a member posted it. */
  app: string | null;
}

export interface WorktreeSummary {
  path: string | null;
  worktree: string | null;
}

export interface MetaSavedSummary {
  path: string | null;
  version: number | null;
  deleted: boolean;
}

export type LineSummary = PushSummary | BranchDeletedSummary | MergedSummary | ReviewSummary | StatusSummary | WorktreeSummary | MetaSavedSummary;

// ── Decoding: JSON from storage, a queue, a socket or a test request, field by field ──

export function textOf(v: Json | undefined): string | null {
  return isText(v) ? v : null;
}

export function wholeOf(v: Json | undefined): number | null {
  return isWholeNumber(v) ? v : null;
}

export function flagOf(v: Json | undefined): boolean | null {
  return v === true || v === false ? v : null;
}

/** A push's summary (push, branch.opened). */
export function pushSummaryOf(v: Json | undefined): PushSummary | null {
  if (!isRecord(v)) return null;
  const out: PushSummary = { head: textOf(v.head), before: textOf(v.before), commits: wholeOf(v.commits), head_title: textOf(v.head_title) };

  if (v.commits_more === true) out.commits_more = true;

  return out;
}

/** A line's summary for its kind; null when the kind has none or the JSON does not carry one. */
export function lineSummaryOf(kind: string, v: Json | undefined): LineSummary | null {
  if (!isRecord(v)) return null;

  switch (kind) {
    case "push":
    case "branch.opened":
      return pushSummaryOf(v);

    case "branch.deleted":
      return { before: textOf(v.before) };
    case "merged":
      return { merge_commit: textOf(v.merge_commit), forced: flagOf(v.forced), title: textOf(v.title), head: textOf(v.head) };
    case "review":
      return { verdict: textOf(v.verdict), comments: wholeOf(v.comments) ?? 0, head: textOf(v.head) };
    case "status": {
      const context = textOf(v.context);
      const state = textOf(v.state);
      const sha = textOf(v.sha);

      if (context === null || state === null || sha === null) return null;

      return { context, state, description: textOf(v.description), target_url: textOf(v.target_url), sha, duration_s: wholeOf(v.duration_s), app: textOf(v.app) };
    }

    case "worktree.reported":
    case "worktree.removed":
      return { path: textOf(v.path), worktree: textOf(v.worktree) };
    case "meta.saved":
      return { path: textOf(v.path), version: wholeOf(v.version), deleted: v.deleted === true };
    default:
      return null;
  }
}

/** A stored line (the event without its monorepo, seq and at). */
export function storedPointerOf(v: Json | undefined): StoredPointer | null {
  if (!isRecord(v)) return null;
  const kind = textOf(v.kind);

  if (kind === null) return null;

  return {
    kind, repo: textOf(v.repo), repo_path: textOf(v.repo_path), branch: textOf(v.branch), actor: textOf(v.actor), machine: textOf(v.machine),
    summary: lineSummaryOf(kind, v.summary),
  };
}

/** A whole line, as a queue message or a test request carries it. */
export function feedEventOf(v: Json | undefined): FeedEvent | null {
  if (!isRecord(v)) return null;
  const p = storedPointerOf(v);
  const monorepoId = textOf(v.monorepo_id);
  const seq = wholeOf(v.seq);
  const at = textOf(v.at);

  if (!p || monorepoId === null || seq === null || at === null) return null;

  return { monorepo_id: monorepoId, monorepo: textOf(v.monorepo) ?? monorepoId, seq, at, ...p };
}

/** A monorepo's summary line, as stored or sent. */
export function summaryOf(v: Json | undefined): Summary | null {
  if (!isRecord(v) || !isRecord(v.needs)) return null;
  const at = textOf(v.at);

  if (at === null) return null;

  return {
    last_activity_at: textOf(v.last_activity_at),
    worktrees_active: wholeOf(v.worktrees_active) ?? 0,
    machines_active: wholeOf(v.machines_active) ?? 0,
    needs: { ready: wholeOf(v.needs.ready) ?? 0, conflicts: wholeOf(v.needs.conflicts) ?? 0, failing: wholeOf(v.needs.failing) ?? 0 },
    members: wholeOf(v.members) ?? 0,
    large: v.large === true,
    repos: wholeOf(v.repos) ?? 0,
    open_branches: wholeOf(v.open_branches) ?? 0,
    at,
  };
}

export function isNeedState(v: string): v is NeedState {
  return NEED_STATES.some((n) => n === v);
}

/** `needs=ready,failing`: the states asked for, or null when one is not a state. */
export function needStatesOf(q: string): NeedState[] | null {
  const parts = q.split(",").map((x) => x.trim()).filter(Boolean);
  const states = parts.filter(isNeedState);

  return states.length === parts.length ? states : null;
}

function needChangeOf(v: Json | undefined): NeedChange | null {
  if (!isRecord(v)) return null;
  const repo = textOf(v.repo);
  const branch = textOf(v.branch);
  const state = textOf(v.state);

  if (repo === null || branch === null) return null;

  return { repo, branch, state: state !== null && isNeedState(state) ? state : null };
}

function listOf<T>(v: Json | undefined, item: (x: Json) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];

  for (const x of v) {
    const t = item(x);

    if (t === null) return null;
    out.push(t);
  }

  return out;
}

/** A list of needs-you changes, as stored in an outbox row or sent in a message. */
export function needChangesOf(v: Json | undefined): NeedChange[] | null {
  return listOf(v, needChangeOf);
}

/** A message for FeedDrain or the queue consumer (the test route decodes with this). */
export function feedMessageOf(v: Json | undefined): FeedMessage | null {
  if (!isRecord(v)) return null;
  const monorepo = textOf(v.monorepo);

  if (monorepo === null) return null;

  switch (v.type) {
    case "events": {
      const members = listOf(v.members, textOf);
      const events = listOf(v.events, feedEventOf);

      return members && events ? { type: "events", monorepo, members, events } : null;
    }

    case "summary": {
      const summary = summaryOf(v.summary);
      const changed = needChangesOf(v.needs_changed);
      // null: a large monorepo's members are read from its object instead.
      const members = v.members === null ? null : listOf(v.members, textOf);

      if (!summary || !changed || (members === null && v.members !== null)) return null;

      return { type: "summary", monorepo, members, summary, needs_changed: changed, needs_more: v.needs_more === true };
    }

    case "member": {
      const login = textOf(v.login);

      return login === null ? null : { type: "member", monorepo, login };
    }

    default:
      return null;
  }
}

/** What a monorepo object stores per activity event: the event without its monorepo, seq and at. */
export type StoredPointer = Omit<FeedEvent, "monorepo_id" | "monorepo" | "seq" | "at">;

/** One monorepo's line on the home. */
export interface Summary {
  last_activity_at: string | null;
  worktrees_active: number;
  machines_active: number;
  needs: { ready: number; conflicts: number; failing: number };
  members: number;
  large: boolean;
  /** Its projects (code repos; the meta layer's repo not counted), and their open branches (main not counted). */
  repos: number;
  open_branches: number;
  /** When the monorepo object computed it. */
  at: string;
}

export type NeedState = "ready" | "conflicts" | "failing";

export const NEED_STATES: NeedState[] = ["ready", "conflicts", "failing"];

export interface NeedChange {
  repo: string;
  branch: string;
  /** Null: the branch left "needs you". */
  state: NeedState | null;
}

/** `failing_apps`: for each failing context, the CI service that reported it (null when a member posted it). */
export interface NeedChecks {
  state: string;
  failing: string[];
  failing_apps: { [context: string]: string | null };
}

/** A branch that needs someone, from stored facts (no Artifacts call). */
export interface NeedRow {
  /** The monorepo's owner/name and id (added by the routes). */
  monorepo?: string;
  monorepo_id?: string;
  repo: string;
  repo_path: string;
  branch: string;
  title: string | null;
  head: string;
  author: string | null;
  pushed_machine: string | null;
  state: NeedState;
  /** `failing_apps`: for each failing context, the CI service that reported it (null when a member posted it). */
  checks: NeedChecks;
  updated_at: string | null;
}

/** Messages to FeedDrain (events, summary) and on pando-feed (member). `monorepo` is always the monorepo's id. */
export type FeedMessage =
  | { type: "events"; monorepo: string; members: string[]; events: FeedEvent[] }
  | { type: "summary"; monorepo: string; members: string[] | null; summary: Summary; needs_changed: NeedChange[]; needs_more: boolean }
  /** A person's membership of a monorepo may have changed: make their feed match the accounts (join with a backfill, or leave). */
  | { type: "member"; monorepo: string; login: string };

// ── The display key and the cursor ──────────────────────────────────────────

export interface Key {
  at: string;
  monorepo_id: string;
  seq: number;
}

/** Newest first: negative when a comes before b on the page. */
export function byKeyDesc(a: Key, b: Key): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;

  if (a.monorepo_id !== b.monorepo_id) return a.monorepo_id < b.monorepo_id ? 1 : -1;

  return b.seq - a.seq;
}

/** The cursor: opaque, "older than this event". About 40 bytes. */
export function encodeCursor(k: Key): string {
  const raw = `${k.at}|${k.monorepo_id}|${k.seq}`;

  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(s: string): Key | null {
  try {
    const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const [at, monorepo_id, seq] = raw.split("|");
    const n = Number(seq);

    if (!at || !monorepo_id || !Number.isSafeInteger(n) || n < 0 || Number.isNaN(Date.parse(at))) return null;

    return { at, monorepo_id, seq: n };
  } catch {
    return null;
  }
}

/**
 * For one monorepo's log: its events older than the cursor are those with
 * at < cursor.at, or at = cursor.at and seq < the bound returned here.
 */
export function seqBound(cursor: Key, monorepoId: string): number {
  if (monorepoId < cursor.monorepo_id) return Number.MAX_SAFE_INTEGER;

  if (monorepoId > cursor.monorepo_id) return 0;

  return cursor.seq;
}

/** Merge pages from several sources: newest first, each (monorepo_id, seq) once, at most `limit`. */
export function mergePages(lists: FeedEvent[][], limit: number): FeedEvent[] {
  const seen = new Set<string>();
  const all: FeedEvent[] = [];

  for (const l of lists) {
    for (const e of l) {
      const k = `${e.monorepo_id}\n${e.seq}`;

      if (seen.has(k)) continue;
      seen.add(k);
      all.push(e);
    }
  }

  return all.sort(byKeyDesc).slice(0, limit);
}

/**
 * Coverage: a feed holds every activity event of a monorepo with at > `after`
 * (null: all of them). PENDING marks a monorepo whose join has not landed yet
 * (nothing is covered). `floor` is the newest `at` the window has dropped.
 */
export const PENDING = "~";

export function effectiveAfter(after: string | null, floor: string | null): string | null {
  if (after === null) return floor;

  if (floor === null) return after;

  return after > floor ? after : floor;
}

/** Whether the feed may lack events of this monorepo that belong on a page whose last event is at `boundary` (null: the page is not full). */
export function uncovered(after: string | null, boundary: string | null): boolean {
  if (after === null) return false;

  return boundary === null || after >= boundary;
}

/** The person's name from a meta layer author ("Ana Lima <ana@x>"). */
export function nameOf(author: string | null): string | null {
  if (!author) return null;
  const i = author.indexOf(" <");

  return (i > 0 ? author.slice(0, i) : author).trim() || null;
}
