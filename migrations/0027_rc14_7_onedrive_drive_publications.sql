-- Only an authenticated super-admin can explicitly publish a file from the authorized /me/drive.
-- Never persist OAuth access tokens or temporary Microsoft download URLs in this table.
CREATE TABLE IF NOT EXISTS onedrive_drive_publications (
 id TEXT PRIMARY KEY NOT NULL,
 drive_id TEXT NOT NULL,
 item_id TEXT NOT NULL,
 file_name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT,
 last_accessed_at TEXT,
 access_count INTEGER NOT NULL DEFAULT 0 CHECK(access_count >= 0),
 last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_onedrive_drive_publications_status ON onedrive_drive_publications(status,created_at DESC);
