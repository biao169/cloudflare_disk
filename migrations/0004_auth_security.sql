-- Auth-stage security state; persisted D1 rate limits work across Worker isolates.
CREATE TABLE IF NOT EXISTS auth_attempts (
 identifier TEXT PRIMARY KEY,
 failures INTEGER NOT NULL DEFAULT 0,
 blocked_until TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id,revoked_at,expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_updated ON auth_attempts(updated_at);
