-- Mirror to GitHub (research/plans/github-mirror-2026-10-04/SPEC.md, 3.5).
-- An installation of the Pando GitHub App is shared by every Pando
-- repository that mirrors with it, so it lives here; each repository's own
-- settings and targets live in its monorepo object. Additive only.
-- (Numbered 0007: profiles takes 0005 and web-links 0006; renumbered at
-- landing if needed.)

CREATE TABLE github_installations (
  id INTEGER PRIMARY KEY,              -- GitHub's installation id
  account_id INTEGER NOT NULL,         -- GitHub's account id (stable)
  account_login TEXT NOT NULL,         -- shown; refreshed when used
  account_type TEXT NOT NULL,          -- 'User' | 'Organization'
  repository_selection TEXT NOT NULL,  -- 'all' | 'selected'
  suspended_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE github_mirror_links (
  monorepo_id TEXT PRIMARY KEY,        -- one connection per Pando repository
  installation_id INTEGER NOT NULL,
  linked_by TEXT NOT NULL,             -- the Pando login who proved access
  github_user_id INTEGER NOT NULL,     -- the GitHub user they proved it as
  linked_at TEXT NOT NULL
);

CREATE INDEX github_mirror_links_installation ON github_mirror_links (installation_id);
