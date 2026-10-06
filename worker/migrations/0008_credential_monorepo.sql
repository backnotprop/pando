-- A credential may be limited to one monorepo: the sandbox credential Pando
-- mints for a Cloudflare-run agent at launch (agents/) works only for the
-- repository it was launched in, and for nothing outside it (no user routes,
-- no other monorepo). Null, as for every credential before this, is the
-- person's whole reach. Additive only.
ALTER TABLE credentials ADD COLUMN monorepo_id TEXT;
