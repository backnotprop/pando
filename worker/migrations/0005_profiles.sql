-- Profiles (profile SPEC section 4, with the owner's answers in
-- decisions/RULINGS.md, "Profiles"): a person's bio, location and links, set
-- in Edit profile. One sign-in email per person (no address list). The
-- contribution counts live in each person's FeedObject, not here. Additive
-- only: no table is copied, nothing moves.

ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN location TEXT;
-- A JSON array of up to 4 https URLs, in the person's order.
ALTER TABLE users ADD COLUMN links TEXT NOT NULL DEFAULT '[]';
-- 1 once the person saved a name: sign-in stops refreshing it from WorkOS.
ALTER TABLE users ADD COLUMN name_edited INTEGER NOT NULL DEFAULT 0;

-- The repositories a person made, for the "Created" line of their profile.
CREATE INDEX monorepos_created_by ON monorepos (created_by, created_at);
