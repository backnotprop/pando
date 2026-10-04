-- A repository's one-line description (owner, 2026-10-04: "add a one-line
-- repository description"), shown under its name on the web and set in its
-- Settings or with `pando monorepo edit --description`. At most 160
-- characters; null when it has none. Additive only. (0005 is the profiles
-- lane's; renumber at landing if needed.)
ALTER TABLE monorepos ADD COLUMN description TEXT;
