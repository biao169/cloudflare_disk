CREATE TABLE IF NOT EXISTS onedrive_quota_counters (
 subject TEXT NOT NULL, window_name TEXT NOT NULL, window_slot INTEGER NOT NULL,
 hits INTEGER NOT NULL DEFAULT 0 CHECK(hits >= 0),
 PRIMARY KEY(subject,window_name,window_slot)
);
CREATE INDEX IF NOT EXISTS idx_onedrive_quota_window ON onedrive_quota_counters(window_name,window_slot);
