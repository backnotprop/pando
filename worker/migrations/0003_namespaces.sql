-- Namespaces (NAMESPACES.md): monorepos are owner/name with a permanent id.
--
-- A monorepo made before this keeps its old name as its id, so its objects,
-- Artifacts repos, R2 keys and queued messages stay where they are. Its owner
-- is its creator. Members and invites move from the name to the id.
-- SQLite can't change a primary key in place, so the three tables are copied.

-- One space for people (their login) and organizations (later).
CREATE TABLE namespaces (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- 'user' (an org is 'org', built later)
  created_at TEXT NOT NULL
);
INSERT INTO namespaces (name, kind, created_at) SELECT login, 'user', created_at FROM users;

CREATE TABLE monorepos_v2 (
  id TEXT PRIMARY KEY,             -- permanent: m_<16 hex>, or the old name for monorepos made before
  owner TEXT NOT NULL,             -- a namespace
  name TEXT NOT NULL,              -- the label, unique within its owner
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (owner, name)
);
INSERT INTO monorepos_v2 (id, owner, name, kind, created_at, created_by)
  SELECT name, created_by, name, kind, created_at, created_by FROM monorepos;

CREATE TABLE members_v2 (
  monorepo_id TEXT NOT NULL,
  login TEXT NOT NULL,
  role TEXT NOT NULL,
  added_at TEXT NOT NULL,
  added_by TEXT,
  PRIMARY KEY (monorepo_id, login)
);
INSERT INTO members_v2 (monorepo_id, login, role, added_at, added_by)
  SELECT monorepo, login, role, added_at, added_by FROM members;

CREATE TABLE invites_v2 (
  monorepo_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (monorepo_id, email)
);
INSERT INTO invites_v2 (monorepo_id, email, role, invited_by, created_at)
  SELECT monorepo, email, role, invited_by, created_at FROM invites;

DROP TABLE invites;
DROP TABLE members;
DROP TABLE monorepos;
ALTER TABLE monorepos_v2 RENAME TO monorepos;
ALTER TABLE members_v2 RENAME TO members;
ALTER TABLE invites_v2 RENAME TO invites;
CREATE INDEX monorepos_name ON monorepos (name);
CREATE INDEX members_login ON members (login);
CREATE INDEX invites_email ON invites (email);

-- Old names after a rename or a transfer: they keep leading to the monorepo
-- until its owner (the alias's owner) gives the name to another one.
CREATE TABLE monorepo_aliases (
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  monorepo_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner, name)
);
CREATE INDEX monorepo_aliases_id ON monorepo_aliases (monorepo_id);
