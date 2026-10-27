-- RC13.1: versioned replacements, compatible with existing logical file IDs.
ALTER TABLE files ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1);
ALTER TABLE upload_sessions ADD COLUMN replace_file_id TEXT REFERENCES files(id);
ALTER TABLE upload_sessions ADD COLUMN expected_revision INTEGER;
CREATE TABLE IF NOT EXISTS file_versions (
 id TEXT PRIMARY KEY,
 file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL,
 object_id TEXT NOT NULL REFERENCES storage_objects(id) ON DELETE RESTRICT,
 size_bytes INTEGER NOT NULL,
 mime_type TEXT NOT NULL,
 created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(file_id,revision)
);
CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id,revision DESC);
