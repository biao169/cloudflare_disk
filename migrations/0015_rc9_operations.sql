-- RC9: additive operational metadata only. Never deletes or rewrites user files.
CREATE TABLE IF NOT EXISTS maintenance_lock (
 id INTEGER PRIMARY KEY CHECK(id=1),
 lease_token TEXT,
 lease_until TEXT
);
INSERT OR IGNORE INTO maintenance_lock(id,lease_token,lease_until) VALUES(1,NULL,NULL);

CREATE TABLE IF NOT EXISTS maintenance_runs (
 id TEXT PRIMARY KEY,
 source TEXT NOT NULL CHECK(source IN ('cron','admin')),
 actor_id TEXT,
 status TEXT NOT NULL CHECK(status IN ('running','completed','partial','failed','skipped')),
 started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 finished_at TEXT,
 result_json TEXT,
 error_count INTEGER NOT NULL DEFAULT 0,
 error_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_maintenance_runs_started ON maintenance_runs(started_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS operational_events (
 id TEXT PRIMARY KEY,
 hour_bucket TEXT NOT NULL,
 source TEXT NOT NULL,
 code TEXT NOT NULL,
 level TEXT NOT NULL CHECK(level IN ('error','warning')),
 message TEXT NOT NULL,
 occurrences INTEGER NOT NULL DEFAULT 1,
 first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 acknowledged_at TEXT,
 acknowledged_by TEXT,
 UNIQUE(hour_bucket,source,code)
);
CREATE INDEX IF NOT EXISTS idx_operational_events_recent ON operational_events(last_seen_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_operational_events_unack ON operational_events(acknowledged_at,level,last_seen_at DESC);

-- Entries are manual attestations, never a claim that an R2 backup was verified.
CREATE TABLE IF NOT EXISTS backup_records (
 id TEXT PRIMARY KEY,
 created_by TEXT NOT NULL,
 backup_type TEXT NOT NULL CHECK(backup_type IN ('d1_only','d1_and_r2')),
 destination_label TEXT NOT NULL,
 notes TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_backup_records_created ON backup_records(created_at DESC,id DESC);
