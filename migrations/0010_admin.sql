-- Stage 11: administration indexes; existing app_settings and space quotas are reused.
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created ON audit_logs(actor_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_spaces_usage ON spaces(used_bytes,reserved_bytes);
