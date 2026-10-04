// Issues in the monorepo object (research/plans/issues-2026-10-04/SPEC.md): one list per monorepo, numbered
// by one counter taken in one synchronous step, so numbers are unique, gap-free and in arrival order. Every
// change is one step: its rows, its timeline items and its event (the monorepo's stream) together. The object
// constructs this with its SQLite; routes.ts validates requests and checks members before calling it.
import { HttpError, now } from "../http";
import { isOneOf, isRecord, isText, isWholeNumber, parseJson, type Json } from "../parse";
import type { ObjectInfo, StreamEvent } from "../monorepo/types";
import { closingRefs } from "./refs";

type Row = Record<string, SqlStorageValue>;

export const LABEL_COLORS = ["gray", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;

export type LabelColor = (typeof LABEL_COLORS)[number];

export const REACTIONS = ["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"] as const;

export type ReactionContent = (typeof REACTIONS)[number];

export type IssueState = "open" | "closed";

export type StateReason = "completed" | "not_planned";

export type LinkSource = "link" | "title" | "commit";

/** A branch's state in one word, as an issue's Development box shows it. */
export type BranchWord = "open" | "ready" | "conflicts" | "failing" | "merged" | "deleted";

/** Who acts: the person and the machine (credential name). Agents act as their person; no agent is stored. */
export interface IssueWho {
  login: string;
  machine: string | null;
  agent: string | null;
}

export interface BranchRef {
  repo: string;
  branch: string;
}

export interface LabelView {
  name: string;
  color: LabelColor;
  description: string | null;
}

export interface ReactionGroup {
  content: ReactionContent;
  count: number;
  by: string[];
}

export interface IssueMergeView {
  repo: string;
  repo_path: string;
  branch: string;
  merge_commit: string;
}

export interface IssueRowView {
  number: number;
  title: string;
  state: IssueState;
  state_reason: StateReason | null;
  project: string | null;
  project_path: string | null;
  labels: LabelView[];
  assignees: string[];
  author: string;
  comments: number;
  tasks: { done: number; total: number } | null;
  linked_branches: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by: string | null;
  closed_by_merge: IssueMergeView | null;
}

export interface IssueLinkView {
  repo: string;
  repo_path: string;
  branch: string;
  sources: LinkSource[];
  sha: string | null;
  linked_by: string | null;
  branch_state: BranchWord;
  merged_at: string | null;
  closed_issue: boolean;
}

export interface IssueView extends IssueRowView {
  body: string;
  body_version: number;
  machine: string | null;
  links: IssueLinkView[];
  participants: string[];
  reactions: ReactionGroup[];
}

export interface CommentView {
  id: string;
  body: string | null;
  body_version: number;
  author: string;
  machine: string | null;
  created_at: string;
  updated_at: string;
  reactions: ReactionGroup[];
}

/** A timeline item: what every one carries, then its kind's own fields. */
export type TimelineView = { id: number; at: string; actor: string | null; machine: string | null } & (
  | { kind: "comment"; comment: CommentView }
  | { kind: "labeled" | "unlabeled"; label: LabelView }
  | { kind: "assigned" | "unassigned"; assignee: string }
  | { kind: "renamed"; from: string; to: string }
  | { kind: "project_changed"; from: string | null; from_path: string | null; to: string | null; to_path: string | null }
  | { kind: "linked"; repo: string; repo_path: string; branch: string; source: LinkSource; sha: string | null }
  | { kind: "unlinked"; repo: string; repo_path: string; branch: string; source: LinkSource }
  | { kind: "closed"; reason: StateReason; merge: IssueMergeView | null }
  | { kind: "reopened" }
  | { kind: "merge_referenced"; merge: IssueMergeView }
);

/** A timeline item's stored data, by kind (issue_timeline.data, JSON). */
type ItemData =
  | { kind: "comment"; comment: string }
  | { kind: "labeled" | "unlabeled"; label: LabelView }
  | { kind: "assigned" | "unassigned"; assignee: string }
  | { kind: "renamed"; from: string; to: string }
  | { kind: "project_changed"; from: string | null; to: string | null }
  | { kind: "linked"; repo: string; branch: string; source: LinkSource; sha: string | null }
  | { kind: "unlinked"; repo: string; branch: string; source: LinkSource }
  | { kind: "closed"; reason: StateReason; merge: number | null }
  | { kind: "reopened" }
  | { kind: "merge_referenced"; merge: number };

type IssueDb = {
  number: number;
  title: string;
  body: string;
  body_version: number;
  state: string;
  state_reason: string | null;
  project: string | null;
  author: string;
  machine: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by: string | null;
  closed_by_merge: number | null;
  comments: number;
  tasks_done: number;
  tasks_total: number;
};

type CommentDb = { id: string; issue: number; body: string; body_version: number; author: string; machine: string | null; created_at: string; updated_at: string };

type ItemDb = { id: number; issue: number; at: string; actor: string | null; machine: string | null; kind: string; data: string };

export interface IssueHost {
  info(): ObjectInfo | null;
  publish(e: StreamEvent): number;
  /** A repo's path by its name; null when there is no such repo. */
  repoPath(name: string): string | null;
  /** A branch's state in one word and when it merged; null when the repo has no such branch, ever. */
  branchWord(repo: string, branch: string): { state: BranchWord; merged_at: string | null } | null;
  /** Open issues assigned to someone changed (the home's summary line). */
  summaryChanged(): void;
}

export interface IssueFilters {
  state: IssueState | "all";
  labels: string[];
  /** A login, or "none". */
  assignee: string | null;
  author: string | null;
  /** A repo's name, or "none". */
  project: string | null;
  linked: BranchRef | null;
  q: string | null;
  sort: "created" | "updated" | "comments";
  order: "desc" | "asc";
  cursor: string | null;
  limit: number;
}

export interface IssueInput {
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  project: string | null;
  link: BranchRef[];
}

export interface IssuePatch {
  title?: string;
  body?: string;
  base_version?: number;
  project?: string | null;
  state?: IssueState;
  state_reason?: StateReason;
  add_labels?: string[];
  remove_labels?: string[];
  add_assignees?: string[];
  remove_assignees?: string[];
  link?: BranchRef[];
  unlink?: BranchRef[];
}

/** Task list lines in a body: done and total. */
export interface TaskCount {
  done: number;
  total: number;
}

/** A page of the list, and the counts for the same filters in either state. */
export interface IssuePage {
  issues: IssueRowView[];
  counts: { open: number; closed: number };
  next_cursor: string | null;
}

export interface TimelinePage {
  items: TimelineView[];
  total: number;
  next_cursor: string | null;
}

/** A create's answer: the issue, and whether a retry with its key found it (`replayed`). */
export interface Created {
  issue: IssueView;
  replayed: boolean;
}

export interface Commented {
  comment: CommentView;
  replayed: boolean;
}

export interface LabelCounts {
  labels: (LabelView & { open_issues: number })[];
}

/** What a merge closes, and when its close step is due. */
export interface MergeCloses {
  closes: number[];
  due: number;
}

export interface LabelPatch {
  name?: string;
  color?: string;
  description?: string | null;
}

export const TITLE_MAX = 256;

export const BODY_MAX = 65_536;

const LABELS_PER_ISSUE = 100;

const ASSIGNEES_PER_ISSUE = 10;

const LABELS_MAX = 500;

/** A comment's body rides in its live event up to this; a larger one is fetched. */
const EVENT_BODY_MAX = 16 * 1024;

/** A merge's issues close this long after it lands, in their own step (pando-ops' call). */
export const CLOSE_AFTER_MS = 1_000;

/** A new monorepo's labels (GitHub seeds nine; four cover the common cases). */
const SEED_LABELS: LabelView[] = [
  { name: "bug", color: "orange", description: "Something isn't working" },
  { name: "enhancement", color: "blue", description: "New feature or request" },
  { name: "documentation", color: "teal", description: "Improvements or additions to documentation" },
  { name: "question", color: "purple", description: "Further information is requested" },
];

function fail(status: number, code: string, message: string, current?: IssueView | CommentView): never {
  throw new HttpError(status, code, message, current ? { current } : {});
}

function isLabelColor(v: string): v is LabelColor {
  return isOneOf(LABEL_COLORS, v);
}

function isStateReason(v: string | null): v is StateReason {
  return v === "completed" || v === "not_planned";
}

function isLinkSource(v: Json | undefined): v is LinkSource {
  return v === "link" || v === "title" || v === "commit";
}

/** `- [ ]` and `- [x]` lines (also `*`, `+` and numbered lists): done and total. */
export function tasksOf(body: string): TaskCount {
  let done = 0;
  let total = 0;

  for (const m of body.matchAll(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/gm)) {
    total++;

    if (m[1] !== " ") done++;
  }

  return { done, total };
}

/** An FTS5 query: each word must appear (quoted, so no syntax gets through), the last one as a prefix; up to 10 words. */
export function ftsQuery(q: string): string | null {
  const words = q.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).slice(0, 10);

  if (!words.length) return null;

  return words.map((w, i) => `"${w.replace(/"/g, '""')}"${i === words.length - 1 ? "*" : ""}`).join(" ");
}

function hexId(prefix: string): string {
  return prefix + [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** A stored item's data, read back from its JSON column; null when it is not one this store writes. */
function itemDataOf(kind: string, v: Json | null): ItemData | null {
  if (!isRecord(v)) return null;
  const text = (x: Json | undefined) => (isText(x) ? x : null);
  const label = isRecord(v.label) && isText(v.label.name) && isText(v.label.color) && isLabelColor(v.label.color) ? { name: v.label.name, color: v.label.color, description: text(v.label.description) } : null;

  switch (kind) {
    case "comment":
      return isText(v.comment) ? { kind, comment: v.comment } : null;
    case "labeled":
    case "unlabeled":
      return label ? { kind, label } : null;
    case "assigned":
    case "unassigned":
      return isText(v.assignee) ? { kind, assignee: v.assignee } : null;
    case "renamed":
      return isText(v.from) && isText(v.to) ? { kind, from: v.from, to: v.to } : null;
    case "project_changed":
      return { kind, from: text(v.from), to: text(v.to) };
    case "linked":
      return isText(v.repo) && isText(v.branch) && isLinkSource(v.source) ? { kind, repo: v.repo, branch: v.branch, source: v.source, sha: text(v.sha) } : null;
    case "unlinked":
      return isText(v.repo) && isText(v.branch) && isLinkSource(v.source) ? { kind, repo: v.repo, branch: v.branch, source: v.source } : null;
    case "closed": {
      const reason = text(v.reason);

      return isStateReason(reason) ? { kind, reason, merge: isWholeNumber(v.merge) ? v.merge : null } : null;
    }

    case "reopened":
      return { kind };
    case "merge_referenced":
      return isWholeNumber(v.merge) ? { kind, merge: v.merge } : null;
    default:
      return null;
  }
}

export class IssueStore {
  constructor(
    private sql: SqlStorage,
    private host: IssueHost,
  ) {}

  private rows<T extends Row>(q: string, ...args: SqlStorageValue[]): T[] {
    return this.sql.exec<T>(q, ...args).toArray();
  }

  private row<T extends Row>(q: string, ...args: SqlStorageValue[]): T | null {
    return this.rows<T>(q, ...args)[0] ?? null;
  }

  private meta(k: string): string | null {
    return this.row<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)?.v ?? null;
  }

  private setMeta(k: string, v: string): void {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }

  /** A new monorepo's four labels, once. */
  seedLabels(): void {
    if (this.meta("labels_seeded")) return;

    for (const l of SEED_LABELS) {
      this.sql.exec("INSERT OR IGNORE INTO labels (name, color, description, created_at, created_by) VALUES (?, ?, ?, ?, 'pando')", l.name, l.color, l.description, now());
    }

    this.setMeta("labels_seeded", "1");
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  private issueDb(n: number): IssueDb | null {
    return this.row<IssueDb>("SELECT * FROM issues WHERE number = ?", n);
  }

  private mustIssue(n: number): IssueDb {
    return this.issueDb(n) ?? fail(404, "not_found", `no issue #${n}`);
  }

  private mergeView(id: number | null): IssueMergeView | null {
    if (id === null) return null;
    const m = this.row<{ repo: string; branch: string; merge_commit: string }>("SELECT repo, branch, merge_commit FROM merges WHERE id = ?", id);

    return m ? { repo: m.repo, repo_path: this.host.repoPath(m.repo) ?? m.repo, branch: m.branch, merge_commit: m.merge_commit } : null;
  }

  private labelsOf(n: number): LabelView[] {
    return this.rows<{ name: string; color: string; description: string | null }>(
      "SELECT l.name AS name, l.color AS color, l.description AS description FROM issue_labels il JOIN labels l ON l.name = il.label WHERE il.issue = ? ORDER BY l.name COLLATE NOCASE",
      n,
    ).flatMap((l) => (isLabelColor(l.color) ? [{ name: l.name, color: l.color, description: l.description }] : []));
  }

  private assigneesOf(n: number): string[] {
    return this.rows<{ login: string }>("SELECT login FROM issue_assignees WHERE issue = ? ORDER BY login", n).map((r) => r.login);
  }

  private rowOf(i: IssueDb): IssueRowView {
    const linked = this.row<{ n: number }>("SELECT COUNT(*) AS n FROM (SELECT DISTINCT repo, branch FROM issue_links WHERE issue = ?)", i.number)?.n ?? 0;
    const reason = i.state_reason;

    return {
      number: i.number,
      title: i.title,
      state: i.state === "closed" ? "closed" : "open",
      state_reason: i.state === "closed" && isStateReason(reason) ? reason : null,
      project: i.project,
      project_path: i.project ? this.host.repoPath(i.project) : null,
      labels: this.labelsOf(i.number),
      assignees: this.assigneesOf(i.number),
      author: i.author,
      comments: i.comments,
      tasks: i.tasks_total > 0 ? { done: i.tasks_done, total: i.tasks_total } : null,
      linked_branches: linked,
      created_at: i.created_at,
      updated_at: i.updated_at,
      closed_at: i.closed_at,
      closed_by: i.closed_by,
      closed_by_merge: this.mergeView(i.closed_by_merge),
    };
  }

  private reactionsOf(n: number, comment: string): ReactionGroup[] {
    const rows = this.rows<{ content: string; login: string }>("SELECT content, login FROM issue_reactions WHERE issue = ? AND comment = ? ORDER BY created_at, login", n, comment);

    return REACTIONS.flatMap((content) => {
      const by = rows.filter((r) => r.content === content).map((r) => r.login);

      return by.length ? [{ content, count: by.length, by }] : [];
    });
  }

  private linksOf(i: IssueDb): IssueLinkView[] {
    const rows = this.rows<{ repo: string; branch: string; source: string; sha: string | null; by: string | null }>(
      "SELECT repo, branch, source, sha, by FROM issue_links WHERE issue = ? ORDER BY created_at, repo, branch",
      i.number,
    );

    const merge = this.mergeView(i.closed_by_merge);
    const out: IssueLinkView[] = [];

    for (const r of rows) {
      if (!isLinkSource(r.source)) continue;
      let link = out.find((x) => x.repo === r.repo && x.branch === r.branch);

      if (!link) {
        const word = this.host.branchWord(r.repo, r.branch);

        link = {
          repo: r.repo, repo_path: this.host.repoPath(r.repo) ?? r.repo, branch: r.branch, sources: [], sha: null, linked_by: null,
          branch_state: word?.state ?? "deleted", merged_at: word?.merged_at ?? null,
          closed_issue: merge !== null && merge.repo === r.repo && merge.branch === r.branch,
        };

        out.push(link);
      }

      link.sources.push(r.source);

      if (r.source === "commit") link.sha = r.sha;

      if (r.source === "link") link.linked_by = r.by;
    }

    return out;
  }

  private participantsOf(i: IssueDb): string[] {
    const seen = [i.author];

    const logins = this.rows<{ login: string }>(
      `SELECT login FROM (SELECT author AS login, created_at AS t FROM issue_comments WHERE issue = ?1
         UNION ALL SELECT actor AS login, at AS t FROM issue_timeline WHERE issue = ?1 AND actor IS NOT NULL) ORDER BY t`,
      i.number,
    );

    for (const r of logins) if (!seen.includes(r.login)) seen.push(r.login);

    return seen;
  }

  private viewOf(i: IssueDb): IssueView {
    return {
      ...this.rowOf(i),
      body: i.body,
      body_version: i.body_version,
      machine: i.machine,
      links: this.linksOf(i),
      participants: this.participantsOf(i),
      reactions: this.reactionsOf(i.number, ""),
    };
  }

  private commentView(c: CommentDb, forEvent = false): CommentView {
    return {
      id: c.id,
      body: forEvent && c.body.length > EVENT_BODY_MAX ? null : c.body,
      body_version: c.body_version,
      author: c.author,
      machine: c.machine,
      created_at: c.created_at,
      updated_at: c.updated_at,
      reactions: this.reactionsOf(c.issue, c.id),
    };
  }

  private itemView(r: ItemDb, forEvent = false): TimelineView | null {
    const d = itemDataOf(r.kind, parseJson(r.data));

    if (!d) return null;
    const base = { id: r.id, at: r.at, actor: r.actor, machine: r.machine };
    const path = (repo: string | null) => (repo ? (this.host.repoPath(repo) ?? repo) : null);

    switch (d.kind) {
      case "comment": {
        const c = this.row<CommentDb>("SELECT * FROM issue_comments WHERE id = ?", d.comment);

        return c ? { ...base, kind: d.kind, comment: this.commentView(c, forEvent) } : null;
      }

      case "project_changed":
        return { ...base, ...d, from_path: path(d.from), to_path: path(d.to) };
      case "linked":
      case "unlinked":
        return { ...base, ...d, repo_path: path(d.repo) ?? d.repo };
      case "closed":
        return { ...base, kind: d.kind, reason: d.reason, merge: this.mergeView(d.merge) };
      case "merge_referenced": {
        const merge = this.mergeView(d.merge);

        return merge ? { ...base, kind: d.kind, merge } : null;
      }

      default:
        return { ...base, ...d };
    }
  }

  get(n: number): IssueView {
    return this.viewOf(this.mustIssue(n));
  }

  /** A page of issues, and the open and closed counts for the same filters. */
  list(f: IssueFilters): IssuePage {
    const where: string[] = [];
    const args: SqlStorageValue[] = [];

    const and = (clause: string, ...values: SqlStorageValue[]) => {
      where.push(clause);
      args.push(...values);
    };

    for (const l of f.labels) and("EXISTS (SELECT 1 FROM issue_labels l WHERE l.issue = i.number AND l.label = ?)", l);

    if (f.assignee === "none") and("NOT EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue = i.number)");
    else if (f.assignee) and("EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue = i.number AND a.login = ?)", f.assignee);

    if (f.author) and("i.author = ?", f.author);

    if (f.project === "none") and("i.project IS NULL");
    else if (f.project) and("i.project = ?", f.project);

    if (f.linked) and("EXISTS (SELECT 1 FROM issue_links k WHERE k.issue = i.number AND k.repo = ? AND k.branch = ?)", f.linked.repo, f.linked.branch);
    const match = f.q ? ftsQuery(f.q) : null;

    if (match) and("i.number IN (SELECT rowid FROM issues_fts WHERE issues_fts MATCH ?)", match);
    const filtered = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const counts = { open: 0, closed: 0 };

    for (const c of this.rows<{ state: string; n: number }>(`SELECT i.state AS state, COUNT(*) AS n FROM issues i ${filtered} GROUP BY i.state`, ...args)) {
      if (c.state === "open" || c.state === "closed") counts[c.state] = c.n;
    }

    if (f.state !== "all") and("i.state = ?", f.state);
    const col = f.sort === "updated" ? "i.updated_at" : f.sort === "comments" ? "i.comments" : "i.number";
    const dir = f.order === "asc" ? "ASC" : "DESC";
    const cmp = f.order === "asc" ? ">" : "<";

    if (f.cursor !== null) {
      const at = f.cursor.lastIndexOf(" ");
      const value = f.cursor.slice(0, at);
      const n = Number(f.cursor.slice(at + 1));

      if (at < 0 || !Number.isSafeInteger(n)) fail(400, "bad_request", "cursor: pass back a next_cursor as it came");
      const v: SqlStorageValue = f.sort === "updated" ? value : Number(value);

      if (f.sort === "created") and(`i.number ${cmp} ?`, n);
      else and(`(${col} ${cmp} ? OR (${col} = ? AND i.number ${cmp} ?))`, v, v, n);
    }

    const page = this.rows<IssueDb>(`SELECT i.* FROM issues i ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${col} ${dir}, i.number ${dir} LIMIT ?`, ...args, f.limit + 1);
    const more = page.length > f.limit;
    const shown = page.slice(0, f.limit);
    const last = shown.at(-1);
    const value = (i: IssueDb) => (f.sort === "updated" ? i.updated_at : f.sort === "comments" ? String(i.comments) : String(i.number));

    return { issues: shown.map((i) => this.rowOf(i)), counts, next_cursor: more && last ? `${value(last)} ${last.number}` : null };
  }

  /** The timeline, oldest first: after `cursor` (an item id), or the newest `last`. */
  timeline(n: number, page: { cursor: number | null; limit: number; last: number | null }): TimelinePage {
    this.mustIssue(n);
    const total = this.row<{ n: number }>("SELECT COUNT(*) AS n FROM issue_timeline WHERE issue = ?", n)?.n ?? 0;

    if (page.last !== null) {
      const rows = this.rows<ItemDb>("SELECT * FROM issue_timeline WHERE issue = ? ORDER BY id DESC LIMIT ?", n, page.last).reverse();

      return { items: rows.flatMap((r) => this.itemView(r) ?? []), total, next_cursor: null };
    }

    const rows = this.rows<ItemDb>("SELECT * FROM issue_timeline WHERE issue = ? AND id > ? ORDER BY id LIMIT ?", n, page.cursor ?? 0, page.limit + 1);
    const more = rows.length > page.limit;
    const shown = rows.slice(0, page.limit);

    return { items: shown.flatMap((r) => this.itemView(r) ?? []), total, next_cursor: more ? String(shown.at(-1)!.id) : null };
  }

  getComment(n: number, id: string): CommentView {
    const c = this.row<CommentDb>("SELECT * FROM issue_comments WHERE id = ? AND issue = ?", id, n) ?? fail(404, "not_found", `no comment ${id} on #${n}`);

    return this.commentView(c);
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /** A timeline item, written now; its view for the event. */
  private addItem(n: number, who: IssueWho | null, data: ItemData): TimelineView | null {
    const at = now();

    const r = this.sql.exec<ItemDb>(
      "INSERT INTO issue_timeline (issue, at, actor, machine, kind, data) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
      n, at, who?.login ?? null, who?.machine ?? null, data.kind, JSON.stringify(data),
    ).one();

    return this.itemView(r, true);
  }

  /** The repos an issue's event is also tagged with: its linked branches'. */
  private linkedRepos(n: number): string[] {
    return this.rows<{ repo: string }>("SELECT DISTINCT repo FROM issue_links WHERE issue = ?", n).map((r) => r.repo);
  }

  /** One event for one change of an issue, written in the same step (topics `issues`, `issue:<n>`, `repo:<repo>`). */
  private publish(kind: string, n: number, who: IssueWho | null, items: (TimelineView | null)[], more: Pick<StreamEvent, "removed" | "comment" | "reactions"> = {}): void {
    const i = this.mustIssue(n);

    this.host.publish({
      kind, collection: "issues", key: String(n), op: "upsert", repo: i.project, actor: who?.login ?? null, machine: who?.machine ?? null, agent: who?.agent ?? null,
      row: this.rowOf(i), number: n, body_version: i.body_version, items: items.filter((x) => x !== null), ...more,
      topics: ["issues", `issue:${n}`, ...this.linkedRepos(n).map((r) => `repo:${r}`)],
    });
  }

  private touch(n: number): void {
    this.sql.exec("UPDATE issues SET updated_at = ? WHERE number = ?", now(), n);
  }

  private checkLabels(names: string[]): void {
    for (const name of names) if (!this.row("SELECT name FROM labels WHERE name = ?", name)) fail(400, "bad_request", `no label ${name}`);
  }

  private checkProject(project: string | null): void {
    if (project !== null && !this.host.repoPath(project)) fail(400, "bad_request", `no project ${project}`);
  }

  private checkLinks(links: BranchRef[]): void {
    for (const l of links) {
      const word = this.host.branchWord(l.repo, l.branch);

      if (!word || word.state === "deleted") fail(400, "bad_request", `no branch ${l.branch} in ${l.repo}`);
    }
  }

  /** Open an issue; a retry with the same key answers the first (`replayed`). */
  create(input: IssueInput, who: IssueWho, key: string | null): Created {
    if (key !== null) {
      const had = this.row<{ number: number }>("SELECT number FROM issues WHERE author = ? AND request_key = ?", who.login, key);

      if (had) return { issue: this.get(had.number), replayed: true };
    }

    this.checkText(input.title, input.body);
    this.checkLabels(input.labels);
    this.checkProject(input.project);
    this.checkLinks(input.link);

    if (input.labels.length > LABELS_PER_ISSUE) fail(400, "bad_request", `at most ${LABELS_PER_ISSUE} labels`);

    if (input.assignees.length > ASSIGNEES_PER_ISSUE) fail(400, "bad_request", `at most ${ASSIGNEES_PER_ISSUE} assignees`);
    // The number: read and bumped in this one step (no await), so it is unique and in arrival order.
    const n = Number(this.meta("issues_next") ?? "1");
    this.setMeta("issues_next", String(n + 1));
    const at = now();
    const tasks = tasksOf(input.body);

    this.sql.exec(
      `INSERT INTO issues (number, title, body, state, project, author, machine, created_at, updated_at, tasks_done, tasks_total, request_key)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
      n, input.title, input.body, input.project, who.login, who.machine, at, at, tasks.done, tasks.total, key,
    );

    for (const l of new Set(input.labels)) this.sql.exec("INSERT OR IGNORE INTO issue_labels (issue, label) VALUES (?, ?)", n, l);

    for (const a of new Set(input.assignees)) this.sql.exec("INSERT OR IGNORE INTO issue_assignees (issue, login) VALUES (?, ?)", n, a);

    for (const l of input.link) this.addLink(n, l, "link", null, who);
    this.publish("issue.opened", n, who, []);

    if (input.assignees.length) this.host.summaryChanged();

    return { issue: this.get(n), replayed: false };
  }

  private checkText(title: string | undefined, body: string | undefined): void {
    if (title !== undefined && (!title.trim() || title.length > TITLE_MAX)) fail(400, "bad_request", `title: 1 to ${TITLE_MAX} characters`);

    if (body !== undefined && body.length > BODY_MAX) fail(413, "too_large", `body: at most ${BODY_MAX} characters`);
  }

  /** A link row (a new one only), with its `linked` item; true when it was new. */
  private addLink(n: number, l: BranchRef, source: LinkSource, sha: string | null, who: IssueWho | null): TimelineView | null {
    const had = this.row("SELECT 1 AS x FROM issue_links WHERE issue = ? AND repo = ? AND branch = ? AND source = ?", n, l.repo, l.branch, source);

    if (had) {
      if (sha !== null) this.sql.exec("UPDATE issue_links SET sha = ? WHERE issue = ? AND repo = ? AND branch = ? AND source = ?", sha, n, l.repo, l.branch, source);

      return null;
    }

    this.sql.exec(
      "INSERT INTO issue_links (issue, repo, branch, source, sha, by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      n, l.repo, l.branch, source, sha, source === "link" ? (who?.login ?? null) : null, now(),
    );

    return this.addItem(n, who, { kind: "linked", repo: l.repo, branch: l.branch, source, sha });
  }

  private removeLink(n: number, l: BranchRef, source: LinkSource, who: IssueWho | null): TimelineView | null {
    const gone = this.sql.exec("DELETE FROM issue_links WHERE issue = ? AND repo = ? AND branch = ? AND source = ?", n, l.repo, l.branch, source).rowsWritten;

    return gone ? this.addItem(n, who, { kind: "unlinked", repo: l.repo, branch: l.branch, source }) : null;
  }

  private label(name: string): LabelView | null {
    const l = this.row<{ name: string; color: string; description: string | null }>("SELECT name, color, description FROM labels WHERE name = ?", name);

    return l && isLabelColor(l.color) ? { name: l.name, color: l.color, description: l.description } : null;
  }

  /** Every change in one step; one event. 409 `edited` when `base_version` is not the body's version now. */
  update(n: number, p: IssuePatch, who: IssueWho): IssueView {
    const i = this.mustIssue(n);

    if (p.body !== undefined && p.base_version !== undefined && p.base_version !== i.body_version) {
      fail(409, "edited", `#${n} was edited since version ${p.base_version}; it is at ${i.body_version}`, this.get(n));
    }

    this.checkText(p.title, p.body);
    this.checkLabels(p.add_labels ?? []);

    if (p.project !== undefined) this.checkProject(p.project);
    this.checkLinks(p.link ?? []);
    const items: (TimelineView | null)[] = [];
    let changed = false;
    let assigned = false;
    let kind = "issue.updated";

    if (p.title !== undefined && p.title !== i.title) {
      this.sql.exec("UPDATE issues SET title = ? WHERE number = ?", p.title, n);
      items.push(this.addItem(n, who, { kind: "renamed", from: i.title, to: p.title }));
      changed = assigned = true;
    }

    if (p.body !== undefined && p.body !== i.body) {
      const t = tasksOf(p.body);
      this.sql.exec("UPDATE issues SET body = ?, body_version = body_version + 1, tasks_done = ?, tasks_total = ? WHERE number = ?", p.body, t.done, t.total, n);
      changed = true;
    }

    if (p.project !== undefined && p.project !== i.project) {
      this.sql.exec("UPDATE issues SET project = ? WHERE number = ?", p.project, n);
      items.push(this.addItem(n, who, { kind: "project_changed", from: i.project, to: p.project }));
      changed = true;
    }

    for (const name of new Set(p.add_labels ?? [])) {
      const l = this.label(name);

      if (l && this.sql.exec("INSERT OR IGNORE INTO issue_labels (issue, label) VALUES (?, ?)", n, l.name).rowsWritten) {
        items.push(this.addItem(n, who, { kind: "labeled", label: l }));
        changed = true;
      }
    }

    if (this.row<{ c: number }>("SELECT COUNT(*) AS c FROM issue_labels WHERE issue = ?", n)!.c > LABELS_PER_ISSUE) fail(400, "bad_request", `at most ${LABELS_PER_ISSUE} labels`);

    for (const name of new Set(p.remove_labels ?? [])) {
      const l = this.label(name);

      if (l && this.sql.exec("DELETE FROM issue_labels WHERE issue = ? AND label = ?", n, l.name).rowsWritten) {
        items.push(this.addItem(n, who, { kind: "unlabeled", label: l }));
        changed = true;
      }
    }

    for (const login of new Set(p.add_assignees ?? [])) {
      if (this.sql.exec("INSERT OR IGNORE INTO issue_assignees (issue, login) VALUES (?, ?)", n, login).rowsWritten) {
        items.push(this.addItem(n, who, { kind: "assigned", assignee: login }));
        changed = assigned = true;
      }
    }

    if (this.assigneesOf(n).length > ASSIGNEES_PER_ISSUE) fail(400, "bad_request", `at most ${ASSIGNEES_PER_ISSUE} assignees`);

    for (const login of new Set(p.remove_assignees ?? [])) {
      if (this.sql.exec("DELETE FROM issue_assignees WHERE issue = ? AND login = ?", n, login).rowsWritten) {
        items.push(this.addItem(n, who, { kind: "unassigned", assignee: login }));
        changed = assigned = true;
      }
    }

    for (const l of p.link ?? []) {
      const it = this.addLink(n, l, "link", null, who);

      if (it) {
        items.push(it);
        changed = true;
      }
    }

    for (const l of p.unlink ?? []) {
      const it = this.removeLink(n, l, "link", who);

      if (it) {
        items.push(it);
        changed = true;
      }
    }

    if (p.state === "closed" && i.state !== "closed") {
      const reason = p.state_reason ?? "completed";
      this.sql.exec("UPDATE issues SET state = 'closed', state_reason = ?, closed_at = ?, closed_by = ?, closed_by_merge = NULL WHERE number = ?", reason, now(), who.login, n);
      items.push(this.addItem(n, who, { kind: "closed", reason, merge: null }));
      changed = assigned = true;
      kind = "issue.closed";
    } else if (p.state === "open" && i.state !== "open") {
      this.sql.exec("UPDATE issues SET state = 'open', state_reason = NULL, closed_at = NULL, closed_by = NULL, closed_by_merge = NULL WHERE number = ?", n);
      items.push(this.addItem(n, who, { kind: "reopened" }));
      changed = assigned = true;
      kind = "issue.reopened";
    }

    if (!changed) return this.get(n);
    this.touch(n);
    this.publish(kind, n, who, items);

    if (assigned) this.host.summaryChanged();

    return this.get(n);
  }

  /** A comment; a retry with the same key answers the first (`replayed`). */
  comment(n: number, body: string, who: IssueWho, key: string | null): Commented {
    this.mustIssue(n);

    if (key !== null) {
      const had = this.row<CommentDb>("SELECT * FROM issue_comments WHERE author = ? AND request_key = ?", who.login, key);

      if (had) return { comment: this.commentView(had), replayed: true };
    }

    if (!body.trim()) fail(400, "bad_request", "body: some text");
    this.checkText(undefined, body);
    const id = hexId("ic_");
    const at = now();
    this.sql.exec("INSERT INTO issue_comments (id, issue, body, author, machine, created_at, updated_at, request_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, n, body, who.login, who.machine, at, at, key);
    this.sql.exec("UPDATE issues SET comments = comments + 1, updated_at = ? WHERE number = ?", at, n);
    this.publish("issue.commented", n, who, [this.addItem(n, who, { kind: "comment", comment: id })]);

    return { comment: this.getComment(n, id), replayed: false };
  }

  private mustComment(n: number, id: string): CommentDb {
    return this.row<CommentDb>("SELECT * FROM issue_comments WHERE id = ? AND issue = ?", id, n) ?? fail(404, "not_found", `no comment ${id} on #${n}`);
  }

  /** The author edits a comment; 409 `edited` when `base_version` is not its version now. */
  editComment(n: number, id: string, body: string, baseVersion: number | null, who: IssueWho): CommentView {
    const c = this.mustComment(n, id);

    if (c.author !== who.login) fail(403, "forbidden", "only its author edits a comment");

    if (baseVersion !== null && baseVersion !== c.body_version) fail(409, "edited", `the comment was edited since version ${baseVersion}`, this.commentView(c));

    if (!body.trim()) fail(400, "bad_request", "body: some text");
    this.checkText(undefined, body);

    if (body === c.body) return this.commentView(c);
    this.sql.exec("UPDATE issue_comments SET body = ?, body_version = body_version + 1, updated_at = ? WHERE id = ?", body, now(), id);
    this.touch(n);
    this.publish("issue.updated", n, who, [], { comment: this.commentView(this.mustComment(n, id), true) });

    return this.getComment(n, id);
  }

  /** Its author, or an owner, deletes a comment: it leaves the timeline. */
  deleteComment(n: number, id: string, who: IssueWho, owner: boolean): void {
    const c = this.mustComment(n, id);

    if (c.author !== who.login && !owner) fail(403, "forbidden", "only its author or an owner deletes a comment");
    const items = this.rows<{ id: number }>("SELECT id FROM issue_timeline WHERE issue = ? AND kind = 'comment' AND data = ?", n, JSON.stringify({ kind: "comment", comment: id })).map((r) => r.id);
    this.sql.exec("DELETE FROM issue_comments WHERE id = ?", id);
    this.sql.exec("DELETE FROM issue_reactions WHERE issue = ? AND comment = ?", n, id);

    for (const item of items) this.sql.exec("DELETE FROM issue_timeline WHERE id = ?", item);
    this.sql.exec("UPDATE issues SET comments = MAX(comments - 1, 0), updated_at = ? WHERE number = ?", now(), n);
    this.publish("issue.updated", n, who, [], { removed: items });
  }

  /** Add (`on`) or take back the person's reaction to the issue (comment null) or one of its comments. */
  react(n: number, comment: string | null, content: ReactionContent, who: IssueWho, on: boolean): ReactionGroup[] {
    this.mustIssue(n);

    if (comment !== null) this.mustComment(n, comment);
    const key = comment ?? "";

    const wrote = on
      ? this.sql.exec("INSERT OR IGNORE INTO issue_reactions (issue, comment, content, login, created_at) VALUES (?, ?, ?, ?, ?)", n, key, content, who.login, now()).rowsWritten
      : this.sql.exec("DELETE FROM issue_reactions WHERE issue = ? AND comment = ? AND content = ? AND login = ?", n, key, content, who.login).rowsWritten;

    const reactions = this.reactionsOf(n, key);

    if (wrote) this.publish("issue.updated", n, who, [], comment === null ? { reactions } : { comment: this.commentView(this.mustComment(n, comment), true) });

    return reactions;
  }

  // ── Labels ───────────────────────────────────────────────────────────────

  labels(): LabelCounts {
    const rows = this.rows<{ name: string; color: string; description: string | null; n: number }>(
      `SELECT l.name AS name, l.color AS color, l.description AS description,
         (SELECT COUNT(*) FROM issue_labels il JOIN issues i ON i.number = il.issue WHERE il.label = l.name AND i.state = 'open') AS n
       FROM labels l ORDER BY l.name COLLATE NOCASE`,
    );

    return { labels: rows.flatMap((l) => (isLabelColor(l.color) ? [{ name: l.name, color: l.color, description: l.description, open_issues: l.n }] : [])) };
  }

  private checkLabel(name: string | undefined, color: string | undefined, description: string | null | undefined): void {
    if (name !== undefined && (!name.trim() || name.length > 50 || name.includes(","))) fail(400, "bad_request", "name: 1 to 50 characters, no comma");

    if (color !== undefined && !isLabelColor(color)) fail(400, "bad_request", `color: one of ${LABEL_COLORS.join(", ")}`);

    if (description && description.length > 100) fail(400, "bad_request", "description: at most 100 characters");
  }

  private publishLabel(who: IssueWho, row: LabelView | { name: string }, op: "upsert" | "delete", from?: string): void {
    const e: StreamEvent = {
      kind: "label.updated", collection: "labels", key: row.name, op, repo: null, actor: who.login, machine: who.machine, agent: who.agent,
      row, topics: ["issues"],
    };

    if (from !== undefined) e.from = from;
    this.host.publish(e);
  }

  createLabel(l: { name: string; color: string; description: string | null }, who: IssueWho): LabelView {
    this.checkLabel(l.name, l.color, l.description);

    if (this.label(l.name)) fail(409, "label_exists", `a label named ${l.name} exists`);

    if (this.row<{ n: number }>("SELECT COUNT(*) AS n FROM labels")!.n >= LABELS_MAX) fail(400, "bad_request", `at most ${LABELS_MAX} labels`);
    this.sql.exec("INSERT INTO labels (name, color, description, created_at, created_by) VALUES (?, ?, ?, ?, ?)", l.name, l.color, l.description, now(), who.login);
    const made = this.label(l.name)!;
    this.publishLabel(who, made, "upsert");

    return made;
  }

  /** Rename, recolour or describe; a rename moves the label on every issue in this one step. */
  updateLabel(name: string, p: LabelPatch, who: IssueWho): LabelView {
    const old = this.label(name) ?? fail(404, "not_found", `no label ${name}`);
    this.checkLabel(p.name, p.color, p.description);
    const to = p.name ?? old.name;

    if (to.toLowerCase() !== old.name.toLowerCase() && this.label(to)) fail(409, "label_exists", `a label named ${to} exists`);
    const color = p.color !== undefined && isLabelColor(p.color) ? p.color : old.color;
    const description = p.description === undefined ? old.description : p.description;
    this.sql.exec("UPDATE labels SET name = ?, color = ?, description = ? WHERE name = ?", to, color, description, old.name);

    if (to !== old.name) this.sql.exec("UPDATE issue_labels SET label = ? WHERE label = ?", to, old.name);
    const now_ = this.label(to)!;
    this.publishLabel(who, now_, "upsert", to !== old.name ? old.name : undefined);

    return now_;
  }

  /** Delete a label: it leaves every issue, with no timeline items (GitHub's way). */
  deleteLabel(name: string, who: IssueWho): void {
    const l = this.label(name) ?? fail(404, "not_found", `no label ${name}`);
    this.sql.exec("DELETE FROM issue_labels WHERE label = ?", l.name);
    this.sql.exec("DELETE FROM labels WHERE name = ?", l.name);
    this.publishLabel(who, { name: l.name }, "delete");
  }

  // ── Branches and merges ──────────────────────────────────────────────────

  private exists(n: number): boolean {
    return this.row("SELECT 1 AS x FROM issues WHERE number = ?", n) !== null;
  }

  /** This monorepo's own names, for `owner/name#12` references. */
  private names(): string[] {
    const m = this.host.info();

    return m ? [m.label] : [];
  }

  /** The issue numbers a text closes here (existing issues only). */
  closingIn(text: string | null): number[] {
    return closingRefs(text, this.names()).filter((n) => this.exists(n));
  }

  /**
   * Replace a branch's links of one source (`title`: its title and description; `commit`: its commits, each
   * with the newest commit naming it), with `linked` and `unlinked` items and an event per issue that moved.
   */
  setLinks(b: BranchRef, source: "title" | "commit", refs: { number: number; sha: string | null }[], who: IssueWho | null): void {
    const want = new Map(refs.flatMap((r) => (this.exists(r.number) ? [[r.number, r.sha] as const] : [])));
    const have = this.rows<{ issue: number; sha: string | null }>("SELECT issue, sha FROM issue_links WHERE repo = ? AND branch = ? AND source = ?", b.repo, b.branch, source);

    for (const h of have) {
      if (want.has(h.issue)) continue;
      const it = this.removeLink(h.issue, b, source, who);
      this.touch(h.issue);
      this.publish("issue.updated", h.issue, who, [it]);
    }

    for (const [n, sha] of want) {
      const known = have.find((h) => h.issue === n);

      if (known) {
        if (known.sha !== sha) this.sql.exec("UPDATE issue_links SET sha = ? WHERE issue = ? AND repo = ? AND branch = ? AND source = ?", sha, n, b.repo, b.branch, source);
        continue;
      }

      const it = this.addLink(n, b, source, sha, who);
      this.touch(n);
      this.publish("issue.updated", n, who, [it]);
    }
  }

  /** Every issue a branch is linked to, any way. */
  linkedTo(b: BranchRef): number[] {
    return this.rows<{ issue: number }>("SELECT DISTINCT issue FROM issue_links WHERE repo = ? AND branch = ? ORDER BY issue", b.repo, b.branch).map((r) => r.issue);
  }

  /**
   * A merge landed (in its record step): of the issues it names, those open now are the ones it closes. The
   * close itself runs about a second later, in its own step (applyCloses); a named issue closed by then gets a
   * `merge_referenced` item instead.
   */
  mergeLanded(merge: number, named: number[]): MergeCloses {
    const issues = [...new Set(named)].filter((n) => this.exists(n)).sort((a, b) => a - b);
    const closes = issues.filter((n) => this.issueDb(n)?.state === "open");
    const due = Date.now() + CLOSE_AFTER_MS;

    if (issues.length) this.sql.exec("INSERT OR REPLACE INTO issue_closes (merge, closes, named, due) VALUES (?, ?, ?, ?)", merge, JSON.stringify(closes), JSON.stringify(issues), due);

    return { closes, due };
  }

  /** The close steps due by now, each once (its row goes in the same step); the next one's time, if any. */
  applyCloses(): number | null {
    const due = this.rows<{ merge: number; closes: string; named: string }>("SELECT merge, closes, named FROM issue_closes WHERE due <= ? ORDER BY due, merge", Date.now());

    for (const job of due) {
      const m = this.row<{ merged_by: string; machine: string | null; agent: string | null }>("SELECT merged_by, machine, agent FROM merges WHERE id = ?", job.merge);
      const who: IssueWho | null = m ? { login: m.merged_by, machine: m.machine, agent: m.agent } : null;
      const closes = numbersOf(parseJson(job.closes));

      for (const n of numbersOf(parseJson(job.named))) {
        const i = this.issueDb(n);

        if (!i) continue;

        if (i.state === "open" && closes.includes(n)) {
          this.sql.exec("UPDATE issues SET state = 'closed', state_reason = 'completed', closed_at = ?, closed_by = ?, closed_by_merge = ?, updated_at = ? WHERE number = ?", now(), who?.login ?? null, job.merge, now(), n);
          this.publish("issue.closed", n, who, [this.addItem(n, who, { kind: "closed", reason: "completed", merge: job.merge })]);
        } else {
          this.publish("issue.updated", n, who, [this.addItem(n, who, { kind: "merge_referenced", merge: job.merge })]);
        }
      }

      this.sql.exec("DELETE FROM issue_closes WHERE merge = ?", job.merge);
    }

    if (due.length) this.host.summaryChanged();

    return this.row<{ t: number | null }>("SELECT MIN(due) AS t FROM issue_closes")?.t ?? null;
  }

  /** Issues a merge's commits named that its close step did not see (its read ran out of time): a `merge_referenced` item each. */
  mergeReferenced(merge: number, numbers: number[]): void {
    const m = this.row<{ merged_by: string; machine: string | null; agent: string | null }>("SELECT merged_by, machine, agent FROM merges WHERE id = ?", merge);

    if (!m) return;
    const who: IssueWho = { login: m.merged_by, machine: m.machine, agent: m.agent };

    for (const n of numbers) {
      if (!this.exists(n)) continue;

      // Once per merge and issue: a close or a reference by this merge is already there.
      const seen = this.rows<{ data: string }>("SELECT data FROM issue_timeline WHERE issue = ? AND kind IN ('closed', 'merge_referenced')", n).some((r) => {
        const d = parseJson(r.data);

        return isRecord(d) && d.merge === merge;
      });

      if (!seen) this.publish("issue.updated", n, who, [this.addItem(n, who, { kind: "merge_referenced", merge })]);
    }
  }
}

/** Issue numbers from a stored JSON list. */
function numbersOf(v: Json | null): number[] {
  return Array.isArray(v) ? v.filter(isWholeNumber) : [];
}
