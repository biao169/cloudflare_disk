-- RC13.3: persistent folder merge/mirror journal. Additive: no existing data is altered.
CREATE TABLE folder_sync_jobs (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 parent_folder_id TEXT,
 root_folder_id TEXT,
 root_name TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('merge','mirror','new')),
 status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','deleting','completed','failed','cancelled')),
 plan_hash TEXT NOT NULL,
 lease_token TEXT,
 lease_until TEXT,
 snapshot_json TEXT NOT NULL,
 expires_at TEXT NOT NULL DEFAULT (datetime('now','+24 hours')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_folder_sync_user_status ON folder_sync_jobs(user_id,status,created_at DESC);
CREATE INDEX idx_folder_sync_expiry ON folder_sync_jobs(status,expires_at);
CREATE TABLE folder_sync_items (
 id TEXT PRIMARY KEY,
 job_id TEXT NOT NULL REFERENCES folder_sync_jobs(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('file','folder','delete_file','delete_folder')),
 action TEXT NOT NULL CHECK(action IN ('create','replace','mkdir','reuse','trash')),
 relative_path TEXT NOT NULL,
 target_id TEXT,
 expected_revision INTEGER,
 expected_size INTEGER,
 expected_mime TEXT,
 result_id TEXT,
 result_revision INTEGER,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed')),
 error_code TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(job_id,kind,relative_path)
);
CREATE INDEX idx_folder_sync_items_status ON folder_sync_items(job_id,status,kind);
