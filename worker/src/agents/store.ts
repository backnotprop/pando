// Agent sessions launched from Pando, in the monorepo object's SQLite: what
// the Agents tab lists. The run itself (its transcript, its sandbox) lives in
// the session's Durable Object in pando-agents, which reports each change of
// state here (reports.ts); every report is one agent.updated event on the
// monorepo's stream (topics `agents`, `agent:<n>`, `repo:<repo>`, and
// `issue:<n>` when it addresses one).

import { HttpError, now } from "../http";
import type { Checks, ObjectInfo, StreamEvent } from "../monorepo/types";
import type { SessionKind, SessionState, Status } from "../../../agents/src/protocol";

export const AGENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_sessions (
  number INTEGER PRIMARY KEY, kind TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL, model TEXT NOT NULL,
  issue INTEGER, launched_by TEXT NOT NULL, machine TEXT NOT NULL, credential_id TEXT,
  status TEXT NOT NULL, reason TEXT, workspace TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  awaiting_checks INTEGER NOT NULL DEFAULT 0, first_message TEXT);
CREATE INDEX IF NOT EXISTS agent_sessions_issue ON agent_sessions (issue, number) WHERE issue IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_sessions_branch ON agent_sessions (repo, branch, number)`;

/** The agent program every launched session runs. */
export const PROGRAM = "pi";

interface AgentRow {
  number: number;
  kind: SessionKind;
  repo: string;
  branch: string;
  model: string;
  issue: number | null;
  launched_by: string;
  machine: string;
  credential_id: string | null;
  status: Status;
  reason: string | null;
  workspace: "mount" | "clone" | null;
  created_at: string;
  updated_at: string;
  awaiting_checks: number;
  first_message: string | null;
}

/** A session as the API shows it (Contract.AgentSession). */
export interface AgentView {
  number: number;
  kind: SessionKind;
  status: Status;
  reason: string | null;
  /** null: an assistant's chat about the whole repository, before it starts a branch in a project. */
  repo: string | null;
  /** null: a chat before it names its branch. */
  branch: string | null;
  program: string;
  model: string;
  issue: number | null;
  launched_by: string;
  machine: string;
  workspace: "mount" | "clone" | null;
  /** Its merge was refused while required checks were still running; Pando tells it when they are green. */
  awaiting_checks: boolean;
  /** A chat's first message, its first 200 characters (the Chats list); null for other kinds. */
  first_message: string | null;
  created_at: string;
  updated_at: string;
  /** In a list: its branch as Pando knows it now; null while the branch is not made yet. */
  branch_facts?: BranchFacts | null;
  /** In a list: the title of the issue it addresses, as it reads now. */
  issue_title?: string | null;
  issue_state?: "open" | "closed" | null;
}

/** What a list row shows of its branch: exact, from the branch's record. */
export interface BranchFacts {
  state: "open" | "merged";
  ahead: number | null;
  /** True while `ahead` is not for the current main and head (computed off the request). */
  stale: boolean;
  merged_at: string | null;
  checks: Checks["state"];
}

/** A page of sessions, newest first, and the counts for the same filters (Contract.AgentSessionList). */
export interface AgentPage {
  sessions: AgentView[];
  next_before: number | null;
  counts: { all: number; working: number; waiting: number };
}

/** What GET .../agents and GET .../assistant filter by; null: any. */
export interface AgentFilters {
  before: number | null;
  limit: number;
  issue: number | null;
  /** A project's branch: the sessions on it (a branch page's reviews). */
  branch: { repo: string; name: string } | null;
  status: "working" | "waiting" | null;
  person: string | null;
  kind: "task" | "issue" | "review" | null;
  /** A login: that person's chats (GET .../assistant); null: the Agents tab (no chats). */
  chatsOf: string | null;
}

export interface AgentInput {
  kind: SessionKind;
  /** null: an assistant's chat about the whole repository. */
  repo: string | null;
  /** The branch it works on; null only for a chat, which names one later (start_branch). */
  branch: string | null;
  model: string;
  issue: number | null;
  /** A chat's first message (kept cut, for its person's Chats list). */
  first_message: string | null;
}

export interface AgentHost {
  info(): ObjectInfo | null;
  publish(e: StreamEvent): number;
}

/** A session's machine name: its credential's, as the Machines tab and comments show it. */
export function machineName(number: number): string {
  return `cloud-${number}`;
}

function view(r: AgentRow): AgentView {
  return {
    number: r.number, kind: r.kind, status: r.status, reason: r.reason, repo: r.repo || null, branch: r.branch || null, program: PROGRAM, model: r.model,
    issue: r.issue, launched_by: r.launched_by, machine: r.machine, workspace: r.workspace, awaiting_checks: r.awaiting_checks === 1,
    first_message: r.first_message, created_at: r.created_at, updated_at: r.updated_at,
  };
}

export class AgentStore {
  constructor(
    private sql: SqlStorage,
    private host: AgentHost,
  ) {}

  private row(number: number): AgentRow | null {
    return this.sql.exec<AgentRow & Record<string, SqlStorageValue>>("SELECT * FROM agent_sessions WHERE number = ?", number).toArray()[0] ?? null;
  }

  private must(number: number): AgentRow {
    const r = this.row(number);

    if (!r) throw new HttpError(404, "not_found", `no agent session ${number}`);

    return r;
  }

  /** Records a new session as working, numbered after the newest. */
  create(input: AgentInput, login: string): AgentView {
    const number = (this.sql.exec<{ n: number | null }>("SELECT MAX(number) AS n FROM agent_sessions").one().n ?? 0) + 1;
    const at = now();
    const branch = input.branch ?? "";

    this.sql.exec(
      "INSERT INTO agent_sessions (number, kind, repo, branch, model, issue, launched_by, machine, status, first_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, ?, ?)",
      number, input.kind, input.repo ?? "", branch, input.model, input.issue, login, machineName(number), input.first_message, at, at,
    );
    this.publish(this.must(number), login);

    return view(this.must(number));
  }

  setCredential(number: number, credentialId: string): void {
    this.sql.exec("UPDATE agent_sessions SET credential_id = ? WHERE number = ?", credentialId, number);
  }

  credentialOf(number: number): string | null {
    return this.must(number).credential_id;
  }

  /** The session a credential belongs to (its sandbox credential), or null for any other. */
  numberOf(credentialId: string): number | null {
    return this.sql.exec<{ number: number }>("SELECT number FROM agent_sessions WHERE credential_id = ?", credentialId).toArray()[0]?.number ?? null;
  }

  /** A session's status, or null when there is no such session. */
  statusOf(number: number): string | null {
    return this.row(number)?.status ?? null;
  }

  get(number: number): AgentView {
    return view(this.must(number));
  }

  /**
   * Newest first; `before` a number to page back. The Agents tab's list
   * (`chatsOf` null) leaves out the assistant's chats; `chatsOf` a login lists
   * that person's chats instead. The counts are for the same filters in
   * every state (the bar's "All 9 · Working 2 · Waiting 2").
   */
  list(f: AgentFilters): AgentPage {
    const where: string[] = [];
    const args: SqlStorageValue[] = [];

    const add = (sql: string, ...v: SqlStorageValue[]) => {
      where.push(sql);
      args.push(...v);
    };

    if (f.chatsOf === null) add("kind NOT IN ('chat', 'understand')");
    else add("kind = 'chat' AND launched_by = ?", f.chatsOf);

    if (f.issue !== null) add("issue = ?", f.issue);

    if (f.branch !== null) add("repo = ? AND branch = ?", f.branch.repo, f.branch.name);

    if (f.person !== null) add("launched_by = ?", f.person);

    if (f.kind !== null) add("kind = ?", f.kind);
    const counted = where.join(" AND ");
    const counts = { all: 0, working: 0, waiting: 0 };

    for (const r of this.sql.exec<{ status: Status; n: number }>(`SELECT status, COUNT(*) AS n FROM agent_sessions WHERE ${counted} GROUP BY status`, ...args)) {
      counts.all += r.n;

      if (r.status === "working" || r.status === "waiting") counts[r.status] += r.n;
    }

    if (f.status !== null) add("status = ?", f.status);
    add("number < ?", f.before ?? Number.MAX_SAFE_INTEGER);

    const rows = this.sql
      .exec<AgentRow & Record<string, SqlStorageValue>>(`SELECT * FROM agent_sessions WHERE ${where.join(" AND ")} ORDER BY number DESC LIMIT ?`, ...args, f.limit + 1)
      .toArray();

    const more = rows.length > f.limit;
    const page = rows.slice(0, f.limit);

    return { sessions: page.map(view), next_before: more ? (page.at(-1)?.number ?? null) : null, counts };
  }


  /** A session's state as its object reports it. A report older than the one kept changes nothing. */
  report(state: SessionState): AgentView | null {
    const r = this.row(state.number);

    if (!r || state.updated_at < r.updated_at) return null;

    this.sql.exec(
      "UPDATE agent_sessions SET status = ?, reason = ?, workspace = COALESCE(?, workspace), repo = COALESCE(NULLIF(?, ''), repo), branch = COALESCE(NULLIF(?, ''), branch), updated_at = ? WHERE number = ?",
      state.status, state.reason ?? null, state.workspace ?? null, state.repo, state.branch, state.updated_at, state.number,
    );
    const next = this.must(state.number);

    if (next.status !== r.status || next.reason !== r.reason || next.workspace !== r.workspace || next.repo !== r.repo || next.branch !== r.branch) this.publish(next, null);

    return view(next);
  }

  /**
   * A merge of (repo, branch) by this credential was refused while required
   * checks were still running: if the credential is a session's on that
   * branch, it waits for them.
   */
  awaitChecks(credentialId: string, repo: string, branch: string): void {
    const r = this.sql
      .exec<AgentRow & Record<string, SqlStorageValue>>("SELECT * FROM agent_sessions WHERE credential_id = ? AND repo = ? AND branch = ? AND awaiting_checks = 0", credentialId, repo, branch)
      .toArray()[0];

    if (!r) return;
    this.sql.exec("UPDATE agent_sessions SET awaiting_checks = 1 WHERE number = ?", r.number);
    this.publish(this.must(r.number), null);
  }

  isAwaiting(repo: string, branch: string): boolean {
    return this.sql.exec("SELECT 1 FROM agent_sessions WHERE repo = ? AND branch = ? AND awaiting_checks = 1 LIMIT 1", repo, branch).toArray().length > 0;
  }

  /**
   * The sessions waiting for (repo, branch)'s checks, no longer waiting: the
   * numbers of those still running to tell. A stopped or failed one stops
   * waiting but is not told: telling it would wake it (two agents can share
   * a branch, and the person stopped this one).
   */
  takeAwaiting(repo: string, branch: string): number[] {
    const rows = this.sql
      .exec<{ number: number; status: string }>("UPDATE agent_sessions SET awaiting_checks = 0 WHERE repo = ? AND branch = ? AND awaiting_checks = 1 RETURNING number, status", repo, branch)
      .toArray();

    for (const r of rows) this.publish(this.must(r.number), null);

    return rows.filter((r) => r.status === "working" || r.status === "waiting").map((r) => r.number);
  }

  private publish(r: AgentRow, actor: string | null): void {
    // A chat is its person's alone, and an Understand page's session shows only through its page: their updates go
    // only to their own topic, and never carry their words.
    const chat = r.kind === "chat" || r.kind === "understand";
    const topics = chat ? [`agent:${r.number}`] : ["agents", `agent:${r.number}`];

    if (r.issue !== null) topics.push(`issue:${r.issue}`);

    this.host.publish({
      kind: "agent.updated", collection: "agents", key: String(r.number), op: "upsert", repo: r.repo || null,
      actor, machine: actor ? null : r.machine, agent: null, number: r.number, row: { ...view(r), first_message: null }, topics,
    });
  }
}
