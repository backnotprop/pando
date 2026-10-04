-- Organizations (profile SPEC section 5): a namespace of kind 'org'. Its
-- people are owners or members; every member can open and push to every
-- monorepo the org owns (monorepos.owner = orgs.login), and its owners own
-- them all. Additive only: no table is copied, nothing moves.

CREATE TABLE orgs (
  login TEXT PRIMARY KEY,          -- its namespace (namespaces.name, kind 'org')
  name TEXT,                       -- the display name
  description TEXT,
  website TEXT,                    -- https only
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE org_members (
  org TEXT NOT NULL,
  login TEXT NOT NULL,
  role TEXT NOT NULL,              -- 'owner' | 'member'
  added_at TEXT NOT NULL,
  added_by TEXT,                   -- null for the org's creator
  PRIMARY KEY (org, login)
);
CREATE INDEX org_members_login ON org_members (login);

-- By email, waiting for that email's first sign-in (as invites, for monorepos).
CREATE TABLE org_invites (
  org TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org, email)
);
CREATE INDEX org_invites_email ON org_invites (email);
