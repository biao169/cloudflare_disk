-- RC14.12: health of explicitly published OneDrive files. Never copy cloud files or auto-publish additions.
ALTER TABLE onedrive_drive_publications ADD COLUMN source_etag TEXT;
ALTER TABLE onedrive_drive_publications ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'unknown'
 CHECK(sync_status IN ('unknown','healthy','changed','missing','denied','reauthorize','throttled','error'));
ALTER TABLE onedrive_drive_publications ADD COLUMN last_checked_at TEXT;
-- SQLite/D1 does not allow a non-constant default on an existing, non-empty table.
-- This UTC sentinel means "due for first check" for both existing and future publications;
-- the first successful or failed check replaces it with a real scheduled UTC timestamp.
ALTER TABLE onedrive_drive_publications ADD COLUMN next_check_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00';
ALTER TABLE onedrive_drive_publications ADD COLUMN last_change_at TEXT;
ALTER TABLE onedrive_drive_publications ADD COLUMN sync_error_code TEXT;
ALTER TABLE onedrive_drive_publications ADD COLUMN sync_error_streak INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_onedrive_pub_sync_due ON onedrive_drive_publications(status,next_check_at,id);

-- Delta cursor is an opaque Microsoft Graph continuation URL; D1 server-only, never returned through public routes.
CREATE TABLE IF NOT EXISTS onedrive_sync_drives (
 drive_id TEXT PRIMARY KEY,
 delta_url TEXT,
 next_scan_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_checked_at TEXT,
 last_completed_at TEXT,
 last_error_code TEXT,
 error_streak INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_onedrive_delta_due ON onedrive_sync_drives(next_scan_at,drive_id);

-- Redacted changes/health history; no Graph URLs, file names, cookies or bearer tokens.
CREATE TABLE IF NOT EXISTS onedrive_sync_events (
 id TEXT PRIMARY KEY,
 publication_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('changed','missing','restored','authorization','throttled','delta_reset','failed')),
 code TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_onedrive_sync_events_created ON onedrive_sync_events(created_at);
