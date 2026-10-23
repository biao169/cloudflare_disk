CREATE TABLE IF NOT EXISTS share_password_attempts (
 id TEXT PRIMARY KEY,
 failures INTEGER NOT NULL DEFAULT 0,
 blocked_until TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_share_password_attempts_expiry ON share_password_attempts(blocked_until);
CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(created_by,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_publication_active_source ON publications(source_file_id) WHERE status='ready';
