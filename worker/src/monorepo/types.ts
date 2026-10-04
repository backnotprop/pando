// Records the monorepo object keeps, as the API returns them.

export type Kind = "monorepo" | "repo";

export type MemberRole = "owner" | "member";

/** The caller: a user, through one of their credentials, and their role in the monorepo. */
export interface Identity {
  login: string;
  name: string | null;
  email: string | null;
  credential_id: string;
  credential_name: string;
  /** machine, sandbox, bootstrap or browser (the Machines tab shows browsers as the web). */
  credential_kind?: string;
  role: MemberRole;
  /** The agent acting, from the X-Pando-Agent header; null for a person. */
  agent?: string | null;
}

/** A monorepo as the API shows it (accounts): permanent id, and owner/name as its label. */
export type { MonorepoInfo } from "../accounts/store";

/**
 * The monorepo object's own record. `id` keys its storage (Artifacts names,
 * the meta layer object, R2, queue messages); for a monorepo made before
 * namespaces it is the old name. `label` is owner/name, for payloads and logs.
 */
export interface ObjectInfo {
  id: string;
  label: string;
  kind: Kind;
  created_at: string;
}

export interface RepoRecord {
  name: string;
  path: string;
  artifacts_name: string;
  remote: string;
  default_branch: string;
  description: string | null;
  created_at: string;
  created_by: string;
}

export interface BranchRecord {
  repo: string;
  name: string;
  head: string | null;
  creator: string | null;
  title: string | null;
  description: string | null;
  created_at: string | null;
  updated_at: string | null;
  merge_commit: string | null;
  merged_head: string | null;
  merged_at: string | null;
  merged_by: string | null;
  /** From the merge that landed merge_commit (joined from merges). */
  merge_forced?: number | null;
  merge_machine?: string | null;
  merge_agent?: string | null;
  /** The credential (machine) that last pushed it. */
  pushed_machine?: string | null;
  /** Stored branch facts (facts.ts), for (facts_main, facts_head). */
  ahead?: number | null;
  behind?: number | null;
  merge_base?: string | null;
  mergeable?: string | null;
  /** The stored dry run's conflicting paths, JSON (with mergeable "conflicts"). */
  conflict_paths?: string | null;
  facts_main?: string | null;
  facts_head?: string | null;
  facts_at?: string | null;
}

export type HookEvent = "push" | "branch.opened" | "merged";

/** An event before it is fanned out to hooks; `base` is filled in by the Worker. */
export interface RepoEvent {
  event: HookEvent;
  repo: string;
  branch: string;
  ref: string;
  before: string;
  head: string;
  base: string | null;
  author: string | null;
  /** Null when the refs compare caught up a push whose pusher Pando never learned. */
  pusher: string | null;
  title: string | null;
  description: string | null;
  merge_commit?: string;
  /** The pusher's credential name (the machine), and the agent if one said so. */
  machine?: string | null;
  agent?: string | null;
  /** The event stream's seq for this change; deliveries are keyed by (hook, event, seq). */
  seq?: number | null;
}

/** One entry of the event stream (api-v1.yaml, EventEnvelope). */
export interface StreamEvent {
  seq?: number;
  at?: string;
  kind: string;
  /** The client-side collection the row belongs to, its key, and what to do with it. */
  collection: string | null;
  key: string | null;
  op: "upsert" | "delete" | null;
  repo?: string | null;
  actor?: string | null;
  machine?: string | null;
  agent?: string | null;
  row: unknown;
  /** push, branch.opened and default_heads events: the branch's head before and after. */
  before?: string;
  head?: string;
  /** merged events: the merge. */
  merge?: MergeResult;
  /** The row holds only the stored fields; the facts follow in a later event. */
  partial?: boolean;
  /** machine.connected and machine.disconnected: the meta layer socket that came or went. */
  connection?: MetaConnection;
  /** Who acted, through which credential: publish() reads it for the Machines tab and never stores it. */
  via?: Via;
}

/**
 * An event from the meta layer object's outbox with its idempotency key: the
 * monorepo object publishes each (source, version) once, however often it is
 * sent ("meta" with the saved version, "meta.presence" with the outbox row).
 */
export interface KeyedEvent {
  source: string;
  version: number;
  event: StreamEvent;
}

/** The pull's narrowing (GET .../events): before a seq, one repo, some kinds. */
export interface EventFilter {
  before?: number | null;
  repo?: string | null;
  kinds?: string[] | null;
}

/** What a reconcile saw before it read Artifacts' refs (object.ts reconcileSeen). */
export interface ReconcileSeen {
  /** The repo's record-move count then. */
  moves: number;
  /** The kept pushes then. */
  ids: number[];
}

/** A review's verdict; a review is comments and an approval, not a gate. */
export type ReviewVerdict = "comment" | "request_changes" | "approve";

/** One comment of a review: a line in the new file (`side` new) or the old one. */
export interface ReviewComment {
  path: string;
  line?: number;
  side: "new" | "old";
  body: string;
}

/** A merge's result, as the merge route answers and merged events carry it. */
export interface MergeResult {
  status: "merged" | "up_to_date";
  branch: string;
  head: string;
  sha: string;
  base_before?: string;
  merge_base?: string;
  forced: boolean;
  merged_by: string;
}

/** Who acted through which credential (publish() receives it; it is never stored in the event's body). */
export interface Via {
  credential_id: string;
  credential_kind: string | null;
}

/** What the monorepo object keeps on each event socket (its event socket route writes it on accept). */
export interface EventSocketAttachment {
  login: string;
  connected_at: string;
  topics: string[];
  /** The socket's id, for presence. */
  sid: string;
  /** The credential's name, the default machine. */
  machine: string;
  /** The credential behind the socket, and its kind (the Machines tab). */
  cid: string;
  kind: string;
}

/** A meta layer socket, as presence events carry it (live/object.ts). */
export interface MetaConnection {
  id: string;
  author: string;
  machine: string;
  agent: string | null;
  client: string | null;
  connected_at: string | null;
}

export interface StatusRecord {
  sha: string;
  context: string;
  state: "pending" | "success" | "failure" | "error";
  target_url: string | null;
  description: string | null;
  /** A user's login, or `app:<slug>` / `hook:<hook id>` for a status posted with a status token or by a CI integration. */
  creator: string;
  /** The CI service that reported it (`buildkite`), stamped by Pando; null when a member posted it. */
  app: string | null;
  created_at: string;
}

export interface Checks {
  sha: string | null;
  state: "success" | "pending" | "failure" | "error" | "missing" | "unknown";
  /** Null while unknown: pando.toml could not be read or does not parse. */
  required: string[] | null;
  missing: string[];
  statuses: StatusRecord[];
  /** Why the required checks are unknown, in plain words; null otherwise. */
  checks_unknown: string | null;
}

/** What a refusal carries in its error body beside code and message (api-v1.yaml, errors). */
export interface RefusalExtra {
  /** A merge refused because required checks are not green: the head's checks. */
  checks?: Checks;
  /** A merge refused with a conflict: the paths changed differently on both sides. */
  paths?: string[];
  /** A CI service's rate limit: when to try again. */
  retry_after_ms?: number;
}

/**
 * DO RPC results: errors travel as data, since RPC keeps only an error's
 * message. `extra` is a named, closed type: with `unknown` values the RPC stub
 * types dropped the whole failure side (`!x.ok` narrowed to never).
 */
export type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string; extra?: RefusalExtra };
