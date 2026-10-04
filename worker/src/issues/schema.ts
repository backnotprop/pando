// Issues' tables in the monorepo object's SQLite (research/plans/issues-2026-10-04/SPEC.md, section 2), and
// the one read the home's summary needs from them. The store (store.ts) owns every write.

export const ISSUES_SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  number INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', body_version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL, state_reason TEXT, project TEXT, author TEXT NOT NULL, machine TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT, closed_by TEXT, closed_by_merge INTEGER,
  comments INTEGER NOT NULL DEFAULT 0, tasks_done INTEGER NOT NULL DEFAULT 0, tasks_total INTEGER NOT NULL DEFAULT 0,
  request_key TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS issues_request ON issues (author, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS issues_created ON issues (state, number);
CREATE INDEX IF NOT EXISTS issues_updated ON issues (state, updated_at, number);
CREATE INDEX IF NOT EXISTS issues_commented ON issues (state, comments, number);
CREATE INDEX IF NOT EXISTS issues_project ON issues (project, state, number);
CREATE INDEX IF NOT EXISTS issues_author ON issues (author, state, number);
CREATE TABLE IF NOT EXISTS issue_comments (
  id TEXT PRIMARY KEY, issue INTEGER NOT NULL, body TEXT NOT NULL, body_version INTEGER NOT NULL DEFAULT 1,
  author TEXT NOT NULL, machine TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, request_key TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS issue_comments_request ON issue_comments (author, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS issue_comments_issue ON issue_comments (issue, created_at);
CREATE TABLE IF NOT EXISTS issue_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT, issue INTEGER NOT NULL, at TEXT NOT NULL,
  actor TEXT, machine TEXT, kind TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS issue_timeline_issue ON issue_timeline (issue, id);
CREATE TABLE IF NOT EXISTS labels (
  name TEXT PRIMARY KEY COLLATE NOCASE, color TEXT NOT NULL, description TEXT, created_at TEXT NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS issue_labels (issue INTEGER NOT NULL, label TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY (issue, label));
CREATE INDEX IF NOT EXISTS issue_labels_label ON issue_labels (label, issue);
CREATE TABLE IF NOT EXISTS issue_assignees (issue INTEGER NOT NULL, login TEXT NOT NULL, PRIMARY KEY (issue, login));
CREATE INDEX IF NOT EXISTS issue_assignees_login ON issue_assignees (login, issue);
CREATE TABLE IF NOT EXISTS issue_links (
  issue INTEGER NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL, source TEXT NOT NULL,
  sha TEXT, by TEXT, created_at TEXT NOT NULL, PRIMARY KEY (issue, repo, branch, source));
CREATE INDEX IF NOT EXISTS issue_links_branch ON issue_links (repo, branch);
CREATE TABLE IF NOT EXISTS issue_reactions (
  issue INTEGER NOT NULL, comment TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, login TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (issue, comment, content, login));
CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(title, body, content='issues', content_rowid='number');
CREATE TRIGGER IF NOT EXISTS issues_fts_insert AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts (rowid, title, body) VALUES (new.number, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS issues_fts_update AFTER UPDATE OF title, body ON issues BEGIN
  INSERT INTO issues_fts (issues_fts, rowid, title, body) VALUES ('delete', old.number, old.title, old.body);
  INSERT INTO issues_fts (rowid, title, body) VALUES (new.number, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS issues_fts_delete AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts (issues_fts, rowid, title, body) VALUES ('delete', old.number, old.title, old.body);
END
`;

/** Statements of a schema with triggers: split on the `;` that ends a statement, keeping a trigger's body whole. */
export function statements(schema: string): string[] {
  const out: string[] = [];
  let cur = "";

  for (const part of schema.split(";")) {
    cur = cur ? `${cur};${part}` : part;

    // Inside a trigger until its END.
    if (/CREATE TRIGGER/i.test(cur) && !/\bEND\s*$/i.test(cur.trim())) continue;

    if (cur.trim()) out.push(cur.trim());
    cur = "";
  }

  return out;
}

/** Open issues assigned to one person: how many, and the most recently updated. */
export interface AssignedIssues {
  count: number;
  newest: { number: number; title: string; updated_at: string };
}

/** Open issues assigned to each member, by login (logins with none are left out). */
export type AssignedByLogin = Record<string, AssignedIssues>;

/** The summary line's AssignedByLogin, read now: one query, each login's count and newest issue. */
export function assignedByLogin(sql: SqlStorage) {
  const rows = sql.exec<{ login: string; n: number; number: number; title: string; updated_at: string }>(
    `SELECT login, n, number, title, updated_at FROM (
       SELECT a.login AS login, COUNT(*) OVER (PARTITION BY a.login) AS n, i.number AS number, i.title AS title, i.updated_at AS updated_at,
         ROW_NUMBER() OVER (PARTITION BY a.login ORDER BY i.updated_at DESC, i.number DESC) AS rn
       FROM issue_assignees a JOIN issues i ON i.number = a.issue WHERE i.state = 'open')
     WHERE rn = 1`,
  ).toArray();

  return Object.fromEntries(rows.map((r) => [r.login, { count: r.n, newest: { number: r.number, title: r.title, updated_at: r.updated_at } }])) satisfies AssignedByLogin;
}
