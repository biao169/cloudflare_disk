-- RC12: Per-user favorites and indexes for bounded global lookup.
-- Additive only; never touches existing files, objects, sessions or shares.
CREATE TABLE IF NOT EXISTS favorites (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 target_type TEXT NOT NULL CHECK(target_type IN ('file','folder')),
 target_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(user_id,target_type,target_id)
);
CREATE INDEX IF NOT EXISTS idx_rc12_favorites_recent ON favorites(user_id,created_at DESC,target_type DESC,target_id DESC);
CREATE INDEX IF NOT EXISTS idx_rc12_files_name_search ON files(name COLLATE NOCASE,space_id,status,deleted_at);
CREATE INDEX IF NOT EXISTS idx_rc12_folders_name_search ON folders(name COLLATE NOCASE,space_id,deleted_at);
