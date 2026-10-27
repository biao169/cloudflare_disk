-- RC13.5: retry scheduling for legacy alias sync. Non-destructive.
ALTER TABLE publication_sync_jobs ADD COLUMN next_retry_at TEXT;
CREATE INDEX IF NOT EXISTS idx_publication_sync_retry ON publication_sync_jobs(status,next_retry_at,created_at);
CREATE INDEX IF NOT EXISTS idx_file_versions_retention ON file_versions(created_at,file_id,revision);
