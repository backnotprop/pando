-- Agent sessions (worker/src/sessions): what a person does not record, followed by every machine they sign in on,
-- and what each machine last reported about its own recording (Settings shows both). Additive only.
-- (Numbered 0009: cloud-agents takes 0008.)

-- A repository (project '') or one of its projects ('projects/web') a person does not record.
CREATE TABLE session_exclusions (
  login TEXT NOT NULL,
  monorepo_id TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (login, monorepo_id, project)
);

-- One row per machine (credential): recording on or off, and the session stores it reads, as it last said.
CREATE TABLE session_machines (
  credential_id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  recording INTEGER NOT NULL,
  stores TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX session_machines_login ON session_machines (login);
