-- File metadata indexes and case-insensitive live sibling naming protection.
CREATE INDEX IF NOT EXISTS idx_files_scope_folder ON files(space_id,folder_id,status,deleted_at,name);
CREATE INDEX IF NOT EXISTS idx_files_name_search ON files(space_id,name);
CREATE INDEX IF NOT EXISTS idx_folders_name_search ON folders(space_id,name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_live_folder_siblings ON folders(space_id,coalesce(parent_id,''),name COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_live_file_siblings ON files(space_id,coalesce(folder_id,''),name COLLATE NOCASE) WHERE deleted_at IS NULL AND status!='deleted';
