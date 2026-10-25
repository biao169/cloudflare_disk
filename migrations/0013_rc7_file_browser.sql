-- RC7: keyset pagination for recent files; only add indexes, preserve existing data.
CREATE INDEX IF NOT EXISTS idx_rc7_recent_files ON files(status,deleted_at,updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_rc7_space_recent ON files(space_id,status,deleted_at,updated_at DESC,id DESC);
