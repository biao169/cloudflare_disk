PRAGMA foreign_keys = ON;
CREATE TABLE users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('super_admin','member')),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 quota_bytes INTEGER NOT NULL DEFAULT 0 CHECK(quota_bytes >= 0), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE spaces (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('personal','team')),
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 quota_bytes INTEGER NOT NULL DEFAULT 0 CHECK(quota_bytes>=0), used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
 reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE space_members (
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
 joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(space_id,user_id)
);
CREATE TABLE folders (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 parent_id TEXT REFERENCES folders(id) ON DELETE RESTRICT, name TEXT NOT NULL,
 deleted_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(length(trim(name)) BETWEEN 1 AND 255), CHECK(id != parent_id)
);
CREATE TABLE folder_permissions (
 id TEXT PRIMARY KEY, folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
 principal_type TEXT NOT NULL CHECK(principal_type IN ('user','role')),
 principal_id TEXT NOT NULL, permission_mask INTEGER NOT NULL CHECK(permission_mask BETWEEN 0 AND 31),
 UNIQUE(folder_id,principal_type,principal_id)
);
CREATE TABLE storage_objects (
 id TEXT PRIMARY KEY, bucket_type TEXT NOT NULL CHECK(bucket_type IN ('private','public')),
 object_key TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL CHECK(size_bytes>=0), etag TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','deleting','deleted','failed')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE files (
 id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 folder_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,
 name TEXT NOT NULL, object_id TEXT NOT NULL REFERENCES storage_objects(id) ON DELETE RESTRICT,
 size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes>=0), mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
 status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','verifying','ready','trashed','failed','deleted')),
 created_by TEXT REFERENCES users(id) ON DELETE SET NULL, deleted_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(length(trim(name)) BETWEEN 1 AND 255)
);
CREATE TABLE upload_sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 target_folder_id TEXT REFERENCES folders(id) ON DELETE RESTRICT,
 object_key TEXT NOT NULL UNIQUE, r2_upload_id TEXT, file_name TEXT NOT NULL,
 total_bytes INTEGER NOT NULL CHECK(total_bytes>=0), reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','uploading','verifying','completed','failed','aborted')),
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE upload_parts (
 upload_session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
 part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000), etag TEXT NOT NULL,
 size_bytes INTEGER NOT NULL CHECK(size_bytes>0), PRIMARY KEY(upload_session_id,part_number)
);
CREATE TABLE shares (
 id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('temporary','page')),
 target_type TEXT NOT NULL CHECK(target_type IN ('file','folder')),
 target_id TEXT NOT NULL, share_code_hash TEXT NOT NULL UNIQUE, password_hash TEXT,
 expires_at TEXT, revoked_at TEXT, max_downloads INTEGER CHECK(max_downloads IS NULL OR max_downloads>0),
 download_count INTEGER NOT NULL DEFAULT 0 CHECK(download_count>=0), allow_download INTEGER NOT NULL DEFAULT 1 CHECK(allow_download IN (0,1)),
 created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE share_access (
 id TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
 session_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL,
 verified_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE publications (
 id TEXT PRIMARY KEY, source_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
 public_object_id TEXT NOT NULL REFERENCES storage_objects(id) ON DELETE RESTRICT,
 public_path TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('publishing','ready','revoked','failed')),
 created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE trash_entries (
 id TEXT PRIMARY KEY, target_type TEXT NOT NULL CHECK(target_type IN ('file','folder')),
 target_id TEXT NOT NULL, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
 original_parent_id TEXT, deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
 deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, purge_at TEXT NOT NULL,
 UNIQUE(target_type,target_id)
);
CREATE TABLE audit_logs (
 id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail_json TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE app_settings (
 key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
