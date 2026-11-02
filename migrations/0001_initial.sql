-- CloudDrive consolidated baseline for fresh installs. This filename deliberately matches the
-- historical first migration, so a previously fully upgraded D1 does not rerun baseline.
-- Contains the final verified schema, with no DROP/DELETE/ALTER or history resets.
-- For older incomplete legacy databases: deploy preflight will stop; back up and finish
-- the original migration chain before switching to this single baseline.

-- TABLE app_settings
CREATE TABLE IF NOT EXISTS app_settings (
 key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- TABLE audit_logs
CREATE TABLE IF NOT EXISTS audit_logs (
 id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail_json TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- TABLE auth_attempts
CREATE TABLE IF NOT EXISTS auth_attempts (
 identifier TEXT PRIMARY KEY,
 failures INTEGER NOT NULL DEFAULT 0,
 blocked_until TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- TABLE backup_records
CREATE TABLE IF NOT EXISTS backup_records (
 id TEXT PRIMARY KEY,
 created_by TEXT NOT NULL,
 backup_type TEXT NOT NULL CHECK(backup_type IN ('d1_only','d1_and_r2')),
 destination_label TEXT NOT NULL,
 notes TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- TABLE favorites
CREATE TABLE IF NOT EXISTS favorites (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 target_type TEXT NOT NULL CHECK(target_type IN ('file','folder')),
 target_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(user_id,target_type,target_id)
);

-- TABLE file_versions
CREATE TABLE IF NOT EXISTS file_versions (
 id TEXT PRIMARY KEY,
 file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL,
 object_id TEXT NOT NULL REFERENCES storage_objects(id) ON DELETE RESTRICT,
 size_bytes INTEGER NOT NULL,
 mime_type TEXT NOT NULL,
 created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(file_id,revision)
);

-- TABLE files
CREATE TABLE IF NOT EXISTS files (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 folder_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,
 name TEXT NOT NULL, object_id TEXT NOT NULL REFERENCES storage_objects(id) ON DELETE RESTRICT,
 size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes>=0), mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
 status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','verifying','ready','trashed','failed','deleted')),
 created_by TEXT REFERENCES users(id) ON DELETE SET NULL, deleted_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
 CHECK(length(trim(name)) BETWEEN 1 AND 255)
);

-- TABLE folder_permissions
CREATE TABLE IF NOT EXISTS folder_permissions (
 id TEXT PRIMARY KEY, folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
 principal_type TEXT NOT NULL CHECK(principal_type IN ('user','role')),
 principal_id TEXT NOT NULL, permission_mask INTEGER NOT NULL CHECK(permission_mask BETWEEN 0 AND 31),
 UNIQUE(folder_id,principal_type,principal_id)
);

-- TABLE folder_sync_items
CREATE TABLE IF NOT EXISTS folder_sync_items (
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

-- TABLE folder_sync_jobs
CREATE TABLE IF NOT EXISTS folder_sync_jobs (
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

-- TABLE folders
CREATE TABLE IF NOT EXISTS folders (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 parent_id TEXT REFERENCES folders(id) ON DELETE RESTRICT, name TEXT NOT NULL,
 deleted_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(length(trim(name)) BETWEEN 1 AND 255), CHECK(id != parent_id)
);

-- TABLE maintenance_lock
CREATE TABLE IF NOT EXISTS maintenance_lock (
 id INTEGER PRIMARY KEY CHECK(id=1),
 lease_token TEXT,
 lease_until TEXT
);

-- TABLE maintenance_runs
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

-- TABLE onedrive_drive_publications
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
, title TEXT, description TEXT, display_name TEXT, cover_style TEXT NOT NULL DEFAULT 'auto', cover_key TEXT, cover_mime TEXT, preview_enabled INTEGER NOT NULL DEFAULT 1 CHECK(preview_enabled IN (0,1)), file_size INTEGER, file_mime TEXT, file_modified_at TEXT, group_id TEXT REFERENCES onedrive_share_groups(id), is_paused INTEGER NOT NULL DEFAULT 0 CHECK(is_paused IN (0,1)), paused_at TEXT, access_mode TEXT NOT NULL DEFAULT 'anyone' CHECK(access_mode IN ('anyone','member')), expires_at TEXT, password_salt TEXT, password_hash TEXT, password_iterations INTEGER, policy_epoch INTEGER NOT NULL DEFAULT 0, max_views INTEGER, max_downloads INTEGER, view_count INTEGER NOT NULL DEFAULT 0, download_count INTEGER NOT NULL DEFAULT 0, show_direct_link INTEGER NOT NULL DEFAULT 1 CHECK(show_direct_link IN (0,1)), source_etag TEXT, sync_status TEXT NOT NULL DEFAULT 'unknown'
 CHECK(sync_status IN ('unknown','healthy','changed','missing','denied','reauthorize','throttled','error')), last_checked_at TEXT, next_check_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00', last_change_at TEXT, sync_error_code TEXT, sync_error_streak INTEGER NOT NULL DEFAULT 0);

-- TABLE onedrive_fixed_links
CREATE TABLE IF NOT EXISTS onedrive_fixed_links (
 id TEXT PRIMARY KEY NOT NULL,
 source_url TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','unavailable')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TEXT,
 last_accessed_at TEXT,
 access_count INTEGER NOT NULL DEFAULT 0 CHECK(access_count>=0),
 last_error TEXT
, delivery_mode TEXT NOT NULL DEFAULT 'source_page_redirect' CHECK(delivery_mode IN ('source_page_redirect','public_direct')));

-- TABLE onedrive_oauth_account
CREATE TABLE IF NOT EXISTS onedrive_oauth_account(id TEXT PRIMARY KEY,encrypted_tokens TEXT NOT NULL,updated_at TEXT NOT NULL);

-- TABLE onedrive_oauth_states
CREATE TABLE IF NOT EXISTS onedrive_oauth_states(state TEXT PRIMARY KEY,owner_id TEXT NOT NULL,verifier TEXT NOT NULL,expires_at INTEGER NOT NULL);

-- TABLE onedrive_quota_counters
CREATE TABLE IF NOT EXISTS onedrive_quota_counters (
 subject TEXT NOT NULL, window_name TEXT NOT NULL, window_slot INTEGER NOT NULL,
 hits INTEGER NOT NULL DEFAULT 0 CHECK(hits >= 0),
 PRIMARY KEY(subject,window_name,window_slot)
);

-- TABLE onedrive_share_daily_stats
CREATE TABLE IF NOT EXISTS onedrive_share_daily_stats (
 scope_id TEXT NOT NULL,
 utc_day TEXT NOT NULL,
 metric TEXT NOT NULL CHECK(metric IN ('view','download','preview','unlock_failure','upstream_error')),
 amount INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(scope_id,utc_day,metric)
);

-- TABLE onedrive_share_group_entries
CREATE TABLE IF NOT EXISTS onedrive_share_group_entries (
 id TEXT PRIMARY KEY NOT NULL CHECK(id GLOB 'ode_*'),
 group_id TEXT NOT NULL REFERENCES onedrive_share_groups(id),
 parent_id TEXT,
 name TEXT NOT NULL,
 entry_type TEXT NOT NULL CHECK(entry_type IN ('folder','file')),
 publication_id TEXT REFERENCES onedrive_drive_publications(id),
 file_size INTEGER,
 mime_type TEXT,
 modified_at TEXT,
 position INTEGER NOT NULL DEFAULT 0,
 CHECK ((entry_type='folder' AND publication_id IS NULL) OR (entry_type='file' AND publication_id IS NOT NULL)),
 FOREIGN KEY(parent_id) REFERENCES onedrive_share_group_entries(id)
);

-- TABLE onedrive_share_groups
CREATE TABLE IF NOT EXISTS onedrive_share_groups (
 id TEXT PRIMARY KEY NOT NULL CHECK(id GLOB 'odg_*'),
 kind TEXT NOT NULL CHECK(kind IN ('folder','collection')),
 title TEXT NOT NULL,
 description TEXT,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
 source_item_id TEXT,
 item_count INTEGER NOT NULL DEFAULT 0,
 folder_count INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT,
 revoked_at TEXT
, is_paused INTEGER NOT NULL DEFAULT 0 CHECK(is_paused IN (0,1)), paused_at TEXT, access_mode TEXT NOT NULL DEFAULT 'anyone' CHECK(access_mode IN ('anyone','member')), expires_at TEXT, password_salt TEXT, password_hash TEXT, password_iterations INTEGER, policy_epoch INTEGER NOT NULL DEFAULT 0, max_views INTEGER, max_downloads INTEGER, view_count INTEGER NOT NULL DEFAULT 0, download_count INTEGER NOT NULL DEFAULT 0, show_direct_link INTEGER NOT NULL DEFAULT 1 CHECK(show_direct_link IN (0,1)));

-- TABLE onedrive_share_unlock_attempts
CREATE TABLE IF NOT EXISTS onedrive_share_unlock_attempts (
 scope_id TEXT NOT NULL,
 visitor_hash TEXT NOT NULL,
 window_id INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(scope_id,visitor_hash,window_id)
);

-- TABLE onedrive_sync_drives
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

-- TABLE onedrive_sync_events
CREATE TABLE IF NOT EXISTS onedrive_sync_events (
 id TEXT PRIMARY KEY,
 publication_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('changed','missing','restored','authorization','throttled','delta_reset','failed')),
 code TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- TABLE operational_events
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

-- TABLE publication_sync_jobs
CREATE TABLE IF NOT EXISTS publication_sync_jobs (
 id TEXT PRIMARY KEY,
 publication_id TEXT NOT NULL,
 space_id TEXT NOT NULL,
 file_revision INTEGER NOT NULL,
 version_object_id TEXT NOT NULL,
 legacy_object_id TEXT NOT NULL,
 reserved_alias_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_alias_bytes>=0),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','copying','purge_pending','completed','superseded','failed')),
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 lease_until TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, next_retry_at TEXT,
 UNIQUE(publication_id,file_revision)
);

-- TABLE publication_versions
CREATE TABLE IF NOT EXISTS publication_versions (
 id TEXT PRIMARY KEY,
 publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
 file_revision INTEGER NOT NULL CHECK(file_revision>=0),
 object_id TEXT NOT NULL REFERENCES storage_objects(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(publication_id,file_revision)
);

-- TABLE publications
CREATE TABLE IF NOT EXISTS publications (
 id TEXT PRIMARY KEY, source_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
 public_object_id TEXT NOT NULL REFERENCES storage_objects(id) ON DELETE RESTRICT,
 public_path TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('publishing','ready','revoked','failed')),
 created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, published_revision INTEGER NOT NULL DEFAULT 0, legacy_object_id TEXT REFERENCES storage_objects(id), sync_state TEXT NOT NULL DEFAULT 'ready'
 CHECK(sync_state IN ('ready','alias_pending','purge_pending','failed','cache_unverified')), auto_sync INTEGER NOT NULL DEFAULT 1 CHECK(auto_sync IN (0,1)));

-- TABLE sessions
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- TABLE share_access
CREATE TABLE IF NOT EXISTS share_access (
 id TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
 session_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL,
 verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- TABLE share_password_attempts
CREATE TABLE IF NOT EXISTS share_password_attempts (
 id TEXT PRIMARY KEY,
 failures INTEGER NOT NULL DEFAULT 0,
 blocked_until TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- TABLE shares
CREATE TABLE IF NOT EXISTS shares (
 id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('temporary','page')),
 target_type TEXT NOT NULL CHECK(target_type IN ('file','folder')),
 target_id TEXT NOT NULL, share_code_hash TEXT NOT NULL UNIQUE, password_hash TEXT,
 expires_at TEXT, revoked_at TEXT, max_downloads INTEGER CHECK(max_downloads IS NULL OR max_downloads>0),
 download_count INTEGER NOT NULL DEFAULT 0 CHECK(download_count>=0), allow_download INTEGER NOT NULL DEFAULT 1 CHECK(allow_download IN (0,1)),
 created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, link_ciphertext TEXT, link_origin TEXT);

-- TABLE space_members
CREATE TABLE IF NOT EXISTS space_members (
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
 joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(space_id,user_id)
);

-- TABLE spaces
CREATE TABLE IF NOT EXISTS spaces (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('personal','team')),
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 quota_bytes INTEGER NOT NULL DEFAULT 0 CHECK(quota_bytes>=0), used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
 reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- TABLE storage_cleanup_jobs
CREATE TABLE IF NOT EXISTS storage_cleanup_jobs (
 id TEXT PRIMARY KEY,
 object_id TEXT NOT NULL UNIQUE,
 object_key TEXT NOT NULL,
 bucket_type TEXT NOT NULL CHECK (bucket_type IN ('private','public')),
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE RESTRICT,
 size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, reserved_release_bytes INTEGER NOT NULL DEFAULT 0, upload_session_id TEXT);

-- TABLE storage_objects
CREATE TABLE IF NOT EXISTS storage_objects (
 id TEXT PRIMARY KEY, bucket_type TEXT NOT NULL CHECK(bucket_type IN ('private','public')),
 object_key TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL CHECK(size_bytes>=0), etag TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','deleting','deleted','failed')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- TABLE trash_entries
CREATE TABLE IF NOT EXISTS trash_entries (
 id TEXT PRIMARY KEY, target_type TEXT NOT NULL CHECK(target_type IN ('file','folder')),
 target_id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 original_parent_id TEXT, deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
 deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, purge_at TEXT NOT NULL,
 UNIQUE(target_type,target_id)
);

-- TABLE trash_entry_items
CREATE TABLE IF NOT EXISTS trash_entry_items (
  trash_id TEXT NOT NULL REFERENCES trash_entries(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL CHECK(item_type IN ('file','folder')),
  item_id TEXT NOT NULL,
  PRIMARY KEY(trash_id,item_type,item_id)
);

-- TABLE upload_parts
CREATE TABLE IF NOT EXISTS upload_parts (
 upload_session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
 part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000), etag TEXT NOT NULL,
 size_bytes INTEGER NOT NULL CHECK(size_bytes>0), PRIMARY KEY(upload_session_id,part_number)
);

-- TABLE upload_sessions
CREATE TABLE IF NOT EXISTS upload_sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 target_folder_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,
 object_key TEXT NOT NULL UNIQUE, r2_upload_id TEXT, file_name TEXT NOT NULL,
 total_bytes INTEGER NOT NULL CHECK(total_bytes>=0), reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','uploading','verifying','completed','failed','aborted')),
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
, part_size INTEGER NOT NULL DEFAULT 8388608, mime_type TEXT NOT NULL DEFAULT 'application/octet-stream', recovery_error TEXT, recovery_attempts INTEGER NOT NULL DEFAULT 0, replace_file_id TEXT REFERENCES files(id), expected_revision INTEGER);

-- TABLE users
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('super_admin','member')),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 quota_bytes INTEGER NOT NULL DEFAULT 0 CHECK(quota_bytes >= 0), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- INDEX idx_audit_actor
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id,created_at DESC);

-- INDEX idx_audit_logs_actor_created
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created ON audit_logs(actor_id,created_at DESC);

-- INDEX idx_audit_logs_created
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC,id DESC);

-- INDEX idx_auth_attempts_updated
CREATE INDEX IF NOT EXISTS idx_auth_attempts_updated ON auth_attempts(updated_at);

-- INDEX idx_backup_records_created
CREATE INDEX IF NOT EXISTS idx_backup_records_created ON backup_records(created_at DESC,id DESC);

-- INDEX idx_file_object_refs
CREATE INDEX IF NOT EXISTS idx_file_object_refs ON files(object_id);

-- INDEX idx_file_versions_file
CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id,revision DESC);

-- INDEX idx_file_versions_retention
CREATE INDEX IF NOT EXISTS idx_file_versions_retention ON file_versions(created_at,file_id,revision);

-- INDEX idx_files_folder
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(space_id,folder_id,status,name);

-- INDEX idx_files_name_search
CREATE INDEX IF NOT EXISTS idx_files_name_search ON files(space_id,name);

-- INDEX idx_files_object
CREATE INDEX IF NOT EXISTS idx_files_object ON files(object_id);

-- INDEX idx_files_recent
CREATE INDEX IF NOT EXISTS idx_files_recent ON files(space_id,created_at DESC);

-- INDEX idx_files_scope_folder
CREATE INDEX IF NOT EXISTS idx_files_scope_folder ON files(space_id,folder_id,status,deleted_at,name);

-- INDEX idx_folder_acl_lookup
CREATE INDEX IF NOT EXISTS idx_folder_acl_lookup ON folder_permissions(folder_id,principal_type,principal_id);

-- INDEX idx_folder_sync_expiry
CREATE INDEX IF NOT EXISTS idx_folder_sync_expiry ON folder_sync_jobs(status,expires_at);

-- INDEX idx_folder_sync_items_status
CREATE INDEX IF NOT EXISTS idx_folder_sync_items_status ON folder_sync_items(job_id,status,kind);

-- INDEX idx_folder_sync_user_status
CREATE INDEX IF NOT EXISTS idx_folder_sync_user_status ON folder_sync_jobs(user_id,status,created_at DESC);

-- INDEX idx_folders_children
CREATE INDEX IF NOT EXISTS idx_folders_children ON folders(space_id,parent_id,deleted_at,name);

-- INDEX idx_folders_name_search
CREATE INDEX IF NOT EXISTS idx_folders_name_search ON folders(space_id,name);

-- INDEX idx_folders_scope
CREATE INDEX IF NOT EXISTS idx_folders_scope ON folders(space_id,parent_id,deleted_at);

-- INDEX idx_maintenance_runs_started
CREATE INDEX IF NOT EXISTS idx_maintenance_runs_started ON maintenance_runs(started_at DESC,id DESC);

-- INDEX idx_member_user
CREATE INDEX IF NOT EXISTS idx_member_user ON space_members(user_id,space_id);

-- INDEX idx_members_user
CREATE INDEX IF NOT EXISTS idx_members_user ON space_members(user_id,space_id);

-- INDEX idx_object_status
CREATE INDEX IF NOT EXISTS idx_object_status ON storage_objects(status,created_at);

-- INDEX idx_onedrive_delta_due
CREATE INDEX IF NOT EXISTS idx_onedrive_delta_due ON onedrive_sync_drives(next_scan_at,drive_id);

-- INDEX idx_onedrive_drive_publications_group
CREATE INDEX IF NOT EXISTS idx_onedrive_drive_publications_group ON onedrive_drive_publications(group_id);

-- INDEX idx_onedrive_drive_publications_status
CREATE INDEX IF NOT EXISTS idx_onedrive_drive_publications_status ON onedrive_drive_publications(status,created_at DESC);

-- INDEX idx_onedrive_fixed_links_owner
CREATE INDEX IF NOT EXISTS idx_onedrive_fixed_links_owner ON onedrive_fixed_links(created_by,created_at DESC);

-- INDEX idx_onedrive_oauth_states_expiry
CREATE INDEX IF NOT EXISTS idx_onedrive_oauth_states_expiry ON onedrive_oauth_states(expires_at);

-- INDEX idx_onedrive_pub_sync_due
CREATE INDEX IF NOT EXISTS idx_onedrive_pub_sync_due ON onedrive_drive_publications(status,next_check_at,id);

-- INDEX idx_onedrive_quota_window
CREATE INDEX IF NOT EXISTS idx_onedrive_quota_window ON onedrive_quota_counters(window_name,window_slot);

-- INDEX idx_onedrive_share_group_entries_parent
CREATE INDEX IF NOT EXISTS idx_onedrive_share_group_entries_parent ON onedrive_share_group_entries(group_id,parent_id,position);

-- INDEX idx_onedrive_share_groups_created
CREATE INDEX IF NOT EXISTS idx_onedrive_share_groups_created ON onedrive_share_groups(created_at DESC);

-- INDEX idx_onedrive_share_stats_day
CREATE INDEX IF NOT EXISTS idx_onedrive_share_stats_day ON onedrive_share_daily_stats(utc_day);

-- INDEX idx_onedrive_sync_events_created
CREATE INDEX IF NOT EXISTS idx_onedrive_sync_events_created ON onedrive_sync_events(created_at);

-- INDEX idx_operational_events_recent
CREATE INDEX IF NOT EXISTS idx_operational_events_recent ON operational_events(last_seen_at DESC,id DESC);

-- INDEX idx_operational_events_unack
CREATE INDEX IF NOT EXISTS idx_operational_events_unack ON operational_events(acknowledged_at,level,last_seen_at DESC);

-- INDEX idx_personal_space_owner
CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_space_owner ON spaces(owner_id) WHERE type='personal';

-- INDEX idx_publication_active_source
CREATE UNIQUE INDEX IF NOT EXISTS idx_publication_active_source ON publications(source_file_id) WHERE status='ready';

-- INDEX idx_publication_sync_jobs_due
CREATE INDEX IF NOT EXISTS idx_publication_sync_jobs_due ON publication_sync_jobs(status,created_at);

-- INDEX idx_publication_sync_retry
CREATE INDEX IF NOT EXISTS idx_publication_sync_retry ON publication_sync_jobs(status,next_retry_at,created_at);

-- INDEX idx_publication_versions_latest
CREATE INDEX IF NOT EXISTS idx_publication_versions_latest ON publication_versions(publication_id,file_revision DESC);

-- INDEX idx_publications_source
CREATE INDEX IF NOT EXISTS idx_publications_source ON publications(source_file_id,status);

-- INDEX idx_publications_source_status
CREATE INDEX IF NOT EXISTS idx_publications_source_status ON publications(source_file_id,status);

-- INDEX idx_rc11_attempts_age
CREATE INDEX IF NOT EXISTS idx_rc11_attempts_age ON auth_attempts(updated_at,identifier);

-- INDEX idx_rc11_files_recent
CREATE INDEX IF NOT EXISTS idx_rc11_files_recent ON files(status,deleted_at,updated_at DESC,id DESC);

-- INDEX idx_rc11_folders_parent_acl
CREATE INDEX IF NOT EXISTS idx_rc11_folders_parent_acl ON folders(parent_id,space_id,deleted_at);

-- INDEX idx_rc11_sessions_expire
CREATE INDEX IF NOT EXISTS idx_rc11_sessions_expire ON sessions(expires_at,id);

-- INDEX idx_rc11_share_access_expire
CREATE INDEX IF NOT EXISTS idx_rc11_share_access_expire ON share_access(expires_at,id);

-- INDEX idx_rc11_share_attempts_age
CREATE INDEX IF NOT EXISTS idx_rc11_share_attempts_age ON share_password_attempts(updated_at,id);

-- INDEX idx_rc12_favorites_recent
CREATE INDEX IF NOT EXISTS idx_rc12_favorites_recent ON favorites(user_id,created_at DESC,target_type DESC,target_id DESC);

-- INDEX idx_rc12_files_name_search
CREATE INDEX IF NOT EXISTS idx_rc12_files_name_search ON files(name COLLATE NOCASE,space_id,status,deleted_at);

-- INDEX idx_rc12_folders_name_search
CREATE INDEX IF NOT EXISTS idx_rc12_folders_name_search ON folders(name COLLATE NOCASE,space_id,deleted_at);

-- INDEX idx_rc7_recent_files
CREATE INDEX IF NOT EXISTS idx_rc7_recent_files ON files(status,deleted_at,updated_at DESC,id DESC);

-- INDEX idx_rc7_space_recent
CREATE INDEX IF NOT EXISTS idx_rc7_space_recent ON files(space_id,status,deleted_at,updated_at DESC,id DESC);

-- INDEX idx_sessions_user_active
CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id,revoked_at,expires_at);

-- INDEX idx_sessions_user_expiry
CREATE INDEX IF NOT EXISTS idx_sessions_user_expiry ON sessions(user_id, expires_at);

-- INDEX idx_share_access_share
CREATE INDEX IF NOT EXISTS idx_share_access_share ON share_access(share_id,expires_at);

-- INDEX idx_share_password_attempts_expiry
CREATE INDEX IF NOT EXISTS idx_share_password_attempts_expiry ON share_password_attempts(blocked_until);

-- INDEX idx_shares_owner
CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(created_by,created_at);

-- INDEX idx_shares_owner_target_status
CREATE INDEX IF NOT EXISTS idx_shares_owner_target_status ON shares(created_by,target_type,target_id,created_at DESC);

-- INDEX idx_shares_target
CREATE INDEX IF NOT EXISTS idx_shares_target ON shares(target_type,target_id);

-- INDEX idx_spaces_owner
CREATE INDEX IF NOT EXISTS idx_spaces_owner ON spaces(owner_id);

-- INDEX idx_spaces_usage
CREATE INDEX IF NOT EXISTS idx_spaces_usage ON spaces(used_bytes,reserved_bytes);

-- INDEX idx_storage_cleanup_created
CREATE INDEX IF NOT EXISTS idx_storage_cleanup_created ON storage_cleanup_jobs(created_at,id);

-- INDEX idx_storage_cleanup_upload
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_cleanup_upload ON storage_cleanup_jobs(upload_session_id) WHERE upload_session_id IS NOT NULL;

-- INDEX idx_storage_objects_state
CREATE INDEX IF NOT EXISTS idx_storage_objects_state ON storage_objects(status,bucket_type);

-- INDEX idx_trash_item_target
CREATE INDEX IF NOT EXISTS idx_trash_item_target ON trash_entry_items(item_type,item_id);

-- INDEX idx_trash_purge
CREATE INDEX IF NOT EXISTS idx_trash_purge ON trash_entries(purge_at,space_id);

-- INDEX idx_upload_expiration
CREATE INDEX IF NOT EXISTS idx_upload_expiration ON upload_sessions(status,expires_at);

-- INDEX idx_upload_recovery
CREATE INDEX IF NOT EXISTS idx_upload_recovery ON upload_sessions(status,updated_at);

-- INDEX idx_upload_recovery_due
CREATE INDEX IF NOT EXISTS idx_upload_recovery_due ON upload_sessions(status,updated_at,expires_at);

-- INDEX idx_upload_session_expiry
CREATE INDEX IF NOT EXISTS idx_upload_session_expiry ON upload_sessions(status,expires_at);

-- INDEX idx_upload_sessions_user
CREATE INDEX IF NOT EXISTS idx_upload_sessions_user ON upload_sessions(user_id,status,expires_at);

-- INDEX uq_files_active_name
CREATE UNIQUE INDEX IF NOT EXISTS uq_files_active_name ON files(space_id,COALESCE(folder_id,''),name COLLATE NOCASE) WHERE status NOT IN ('trashed','deleted','failed');

-- INDEX uq_folders_active_name
CREATE UNIQUE INDEX IF NOT EXISTS uq_folders_active_name ON folders(space_id,COALESCE(parent_id,''),name COLLATE NOCASE) WHERE deleted_at IS NULL;

-- INDEX uq_live_file_siblings
CREATE UNIQUE INDEX IF NOT EXISTS uq_live_file_siblings ON files(space_id,coalesce(folder_id,''),name COLLATE NOCASE) WHERE deleted_at IS NULL AND status!='deleted';

-- INDEX uq_live_folder_siblings
CREATE UNIQUE INDEX IF NOT EXISTS uq_live_folder_siblings ON folders(space_id,coalesce(parent_id,''),name COLLATE NOCASE) WHERE deleted_at IS NULL;

-- INDEX uq_personal_space_owner
CREATE UNIQUE INDEX IF NOT EXISTS uq_personal_space_owner ON spaces(owner_id) WHERE type='personal';

-- TRIGGER trg_od_share_group_download
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

-- Initial defaults: do not change values on an existing D1.
INSERT OR IGNORE INTO app_settings(key,value_json) VALUES
  ('storage_soft_limit_bytes','8589934592'),
  ('default_share_expiry_days','7'),
  ('trash_retention_days','7'),
  ('registration_enabled','false');
INSERT OR IGNORE INTO maintenance_lock(id,lease_token,lease_until) VALUES(1,NULL,NULL);
