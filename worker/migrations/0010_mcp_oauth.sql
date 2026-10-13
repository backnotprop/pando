-- MCP sign-in (worker/src/mcp): Pando is the authorization server for its own MCP endpoint (/mcp). A
-- person's MCP host (Claude Code, Codex, Cursor) registers or names its client, the person signs in and
-- clicks Allow, and the host trades a one-time code for a credential of kind "mcp" in `credentials`,
-- named after the client. Additive only.

-- The client a credential of kind "mcp" was made for: its client_id (a URL for a Client ID Metadata
-- Document, else a registered id). Null for every other kind.
ALTER TABLE credentials ADD COLUMN client_id TEXT;
CREATE INDEX credentials_client ON credentials (login, client_id);

-- The apps that asked: registered (kind 'dcr', id pmc_...) or a Client ID Metadata Document fetched and
-- kept (kind 'cimd', id its URL). redirect_uris is a JSON array of strings. used_at: its first code.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at TEXT NOT NULL,
  fetched_at TEXT,
  used_at TEXT
);
CREATE INDEX oauth_clients_unused ON oauth_clients (kind, used_at, created_at);

-- An Allow click waiting: what the consent page showed, kept until the click (or ten minutes). The
-- browser holds only the id, in a cookie, and the form sends it back.
CREATE TABLE oauth_consents (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT,
  expires_at TEXT NOT NULL
);

-- One-time authorization codes (SHA-256 hashes), five minutes each, bound to everything the exchange
-- must match. consumed_at is set once, before the PKCE check, so a wrong verifier burns the code.
CREATE TABLE oauth_codes (
  hash TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX oauth_codes_grant ON oauth_codes (login, client_id);
