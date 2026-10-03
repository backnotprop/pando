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
  role: MemberRole;
}

export interface MonorepoInfo {
  name: string;
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
  pusher: string;
  title: string | null;
  description: string | null;
  merge_commit?: string;
}

export interface StatusRecord {
  sha: string;
  context: string;
  state: "pending" | "success" | "failure" | "error";
  target_url: string | null;
  description: string | null;
  creator: string;
  created_at: string;
}

export interface Checks {
  sha: string | null;
  state: "success" | "pending" | "failure" | "error" | "missing";
  required: string[];
  missing: string[];
  statuses: StatusRecord[];
}

/** DO RPC results: errors travel as data, since RPC keeps only an error's message. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string; extra?: Record<string, unknown> };
