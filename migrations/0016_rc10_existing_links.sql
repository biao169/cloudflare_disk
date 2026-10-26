-- RC10: Preserve the exact origin used when new share URLs are created.
-- Existing links cannot have their historical origin inferred from a SHA-256 digest.
-- Additive D1 migration: keep all users, files, and sharing records unchanged.
ALTER TABLE shares ADD COLUMN link_origin TEXT;
