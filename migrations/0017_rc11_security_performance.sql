-- RC11: strictly additive indexes for bounded pagination, membership checks,
-- expiry cleanup and short-lived login/share attempt state. No data mutation.
CREATE INDEX IF NOT EXISTS idx_rc11_files_recent ON files(status,deleted_at,updated_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_rc11_sessions_expire ON sessions(expires_at,id);
CREATE INDEX IF NOT EXISTS idx_rc11_share_access_expire ON share_access(expires_at,id);
CREATE INDEX IF NOT EXISTS idx_rc11_attempts_age ON auth_attempts(updated_at,identifier);
CREATE INDEX IF NOT EXISTS idx_rc11_share_attempts_age ON share_password_attempts(updated_at,id);
CREATE INDEX IF NOT EXISTS idx_rc11_folders_parent_acl ON folders(parent_id,space_id,deleted_at);
