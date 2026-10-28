-- Secrets are AES-GCM encrypted with MS_TOKEN_KEY. Never return token columns from APIs.
CREATE TABLE IF NOT EXISTS onedrive_oauth_account(id TEXT PRIMARY KEY,encrypted_tokens TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS onedrive_oauth_states(state TEXT PRIMARY KEY,owner_id TEXT NOT NULL,verifier TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_onedrive_oauth_states_expiry ON onedrive_oauth_states(expires_at);
