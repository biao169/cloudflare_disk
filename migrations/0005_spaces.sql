-- Stage 4: protect one personal space per owner and optimize directory permissions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_space_owner ON spaces(owner_id) WHERE type='personal';
CREATE INDEX IF NOT EXISTS idx_spaces_owner ON spaces(owner_id,type);
CREATE INDEX IF NOT EXISTS idx_members_user ON space_members(user_id,space_id);
CREATE INDEX IF NOT EXISTS idx_folder_acl_lookup ON folder_permissions(folder_id,principal_type,principal_id);
CREATE INDEX IF NOT EXISTS idx_folders_scope ON folders(space_id,parent_id,deleted_at);
