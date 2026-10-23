ALTER TABLE upload_sessions ADD COLUMN part_size INTEGER NOT NULL DEFAULT 8388608;
ALTER TABLE upload_sessions ADD COLUMN mime_type TEXT NOT NULL DEFAULT 'application/octet-stream';
CREATE INDEX IF NOT EXISTS idx_upload_session_expiry ON upload_sessions(status,expires_at);
