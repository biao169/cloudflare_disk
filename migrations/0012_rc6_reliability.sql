-- RC6: preserve exactly which descendants were deleted by a folder trash action.
-- Prior trash entries remain valid; code uses a conservative legacy fallback.
CREATE TABLE IF NOT EXISTS trash_entry_items (
  trash_id TEXT NOT NULL REFERENCES trash_entries(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK(item_type IN ('file','folder')),
  item_id TEXT NOT NULL,
  PRIMARY KEY(trash_id,item_type,item_id)
);
CREATE INDEX IF NOT EXISTS idx_trash_item_target ON trash_entry_items(item_type,item_id);

-- Durable recovery diagnostics for R2 multipart completion interrupted after R2 succeeds.
ALTER TABLE upload_sessions ADD COLUMN recovery_error TEXT;
ALTER TABLE upload_sessions ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;

-- Reserve bytes for orphaned completed multipart objects until R2 actually deletes them.
ALTER TABLE storage_cleanup_jobs ADD COLUMN reserved_release_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storage_cleanup_jobs ADD COLUMN upload_session_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_cleanup_upload ON storage_cleanup_jobs(upload_session_id) WHERE upload_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_upload_recovery_due ON upload_sessions(status,updated_at,expires_at);
