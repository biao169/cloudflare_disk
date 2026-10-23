-- Stage 12: durable cleanup outbox. An R2 deletion must not be lost if D1 fails
-- after the logical file has been permanently removed.
CREATE TABLE IF NOT EXISTS storage_cleanup_jobs (
 id TEXT PRIMARY KEY,
 object_id TEXT NOT NULL UNIQUE,
 object_key TEXT NOT NULL,
 bucket_type TEXT NOT NULL CHECK (bucket_type IN ('private','public')),
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE RESTRICT,
 size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_storage_cleanup_created ON storage_cleanup_jobs(created_at,id);
CREATE INDEX IF NOT EXISTS idx_upload_recovery ON upload_sessions(status,updated_at);
CREATE INDEX IF NOT EXISTS idx_storage_objects_state ON storage_objects(status,bucket_type);

-- Upgrade from Stage 11: public copies were not included in per-space usage.
-- This runs once through the migration system; new publications update used_bytes.
UPDATE spaces SET used_bytes=used_bytes+COALESCE((
 SELECT SUM(o.size_bytes) FROM publications p
 JOIN files f ON f.id=p.source_file_id
 JOIN storage_objects o ON o.id=p.public_object_id
 WHERE f.space_id=spaces.id AND p.status='ready' AND o.status='ready'
),0);
