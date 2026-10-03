-- Accounts on D1 (C8): users, credentials (SHA-256 hashes), monorepos,
-- members and invites. The same tables the AccountsObject kept, with the
-- columns it added later (workos_id, expires_at, workos_sid) folded in.
-- Apply: npx wrangler d1 migrations apply <database> --local | --remote

CREATE TABLE users (
  login TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  created_at TEXT NOT NULL,
  workos_id TEXT
);
CREATE UNIQUE INDEX users_workos ON users (workos_id);
CREATE INDEX users_email ON users (lower(email));

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  expires_at TEXT,
  workos_sid TEXT
);
CREATE INDEX credentials_login ON credentials (login);

CREATE TABLE monorepos (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE members (
  monorepo TEXT NOT NULL,
  login TEXT NOT NULL,
  role TEXT NOT NULL,
  added_at TEXT NOT NULL,
  added_by TEXT,
  PRIMARY KEY (monorepo, login)
);
CREATE INDEX members_login ON members (login);

CREATE TABLE invites (
  monorepo TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (monorepo, email)
);
CREATE INDEX invites_email ON invites (email);
