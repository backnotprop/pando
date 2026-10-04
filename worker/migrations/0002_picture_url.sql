-- People's pictures: the WorkOS user's profile_picture_url, refreshed on each
-- sign-in. Null when they have none (the web draws one). Never proxied.
ALTER TABLE users ADD COLUMN picture_url TEXT;
