-- RC14.11: additive policy columns. Keep historical 'active/revoked' CHECK constraints.
-- Pause is independent from revocation so existing IDs remain recoverable.
ALTER TABLE onedrive_drive_publications ADD COLUMN is_paused INTEGER NOT NULL DEFAULT 0 CHECK(is_paused IN (0,1));
ALTER TABLE onedrive_drive_publications ADD COLUMN paused_at TEXT;
ALTER TABLE onedrive_drive_publications ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'anyone' CHECK(access_mode IN ('anyone','member'));
ALTER TABLE onedrive_drive_publications ADD COLUMN expires_at TEXT;
ALTER TABLE onedrive_drive_publications ADD COLUMN password_salt TEXT;
ALTER TABLE onedrive_drive_publications ADD COLUMN password_hash TEXT;
ALTER TABLE onedrive_drive_publications ADD COLUMN password_iterations INTEGER;
ALTER TABLE onedrive_drive_publications ADD COLUMN policy_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE onedrive_drive_publications ADD COLUMN max_views INTEGER;
ALTER TABLE onedrive_drive_publications ADD COLUMN max_downloads INTEGER;
ALTER TABLE onedrive_drive_publications ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE onedrive_drive_publications ADD COLUMN download_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE onedrive_drive_publications ADD COLUMN show_direct_link INTEGER NOT NULL DEFAULT 1 CHECK(show_direct_link IN (0,1));
ALTER TABLE onedrive_share_groups ADD COLUMN is_paused INTEGER NOT NULL DEFAULT 0 CHECK(is_paused IN (0,1));
ALTER TABLE onedrive_share_groups ADD COLUMN paused_at TEXT;
ALTER TABLE onedrive_share_groups ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'anyone' CHECK(access_mode IN ('anyone','member'));
ALTER TABLE onedrive_share_groups ADD COLUMN expires_at TEXT;
ALTER TABLE onedrive_share_groups ADD COLUMN password_salt TEXT;
ALTER TABLE onedrive_share_groups ADD COLUMN password_hash TEXT;
ALTER TABLE onedrive_share_groups ADD COLUMN password_iterations INTEGER;
ALTER TABLE onedrive_share_groups ADD COLUMN policy_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE onedrive_share_groups ADD COLUMN max_views INTEGER;
ALTER TABLE onedrive_share_groups ADD COLUMN max_downloads INTEGER;
ALTER TABLE onedrive_share_groups ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE onedrive_share_groups ADD COLUMN download_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE onedrive_share_groups ADD COLUMN show_direct_link INTEGER NOT NULL DEFAULT 1 CHECK(show_direct_link IN (0,1));
-- No plaintext IPs, passwords, user agents or Microsoft tokens in telemetry.
CREATE TABLE IF NOT EXISTS onedrive_share_unlock_attempts (
 scope_id TEXT NOT NULL,
 visitor_hash TEXT NOT NULL,
 window_id INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(scope_id,visitor_hash,window_id)
);
CREATE TABLE IF NOT EXISTS onedrive_share_daily_stats (
 scope_id TEXT NOT NULL,
 utc_day TEXT NOT NULL,
 metric TEXT NOT NULL CHECK(metric IN ('view','download','preview','unlock_failure','upstream_error')),
 amount INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(scope_id,utc_day,metric)
);
CREATE INDEX IF NOT EXISTS idx_onedrive_share_stats_day ON onedrive_share_daily_stats(utc_day);
-- A single file-counter UPDATE atomically enforces the parent collection limit.
-- Abort (and rollback) rather than increment the file while leaving its parent unchanged.
CREATE TRIGGER IF NOT EXISTS trg_od_share_group_download
BEFORE UPDATE OF download_count ON onedrive_drive_publications
WHEN NEW.download_count > OLD.download_count AND OLD.group_id IS NOT NULL
BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM onedrive_share_groups g WHERE g.id=OLD.group_id
   AND g.status='active' AND g.is_paused=0
   AND (g.expires_at IS NULL OR strftime('%s',g.expires_at)>strftime('%s','now'))
   AND (g.max_downloads IS NULL OR g.download_count<g.max_downloads)
 ) THEN RAISE(ABORT,'ONEDRIVE_GROUP_DOWNLOAD_BLOCKED') END;
 UPDATE onedrive_share_groups SET download_count=download_count+1 WHERE id=OLD.group_id;
END;
