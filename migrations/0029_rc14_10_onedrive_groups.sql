-- RC14.10: explicitly published static folder snapshots / cross-folder collections.
-- No automatic publication of newly added OneDrive contents.
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
);
CREATE INDEX IF NOT EXISTS idx_onedrive_share_groups_created ON onedrive_share_groups(created_at DESC);

-- One group-owned file publication per included file. Keep existing odf_* download and preview routes.
ALTER TABLE onedrive_drive_publications ADD COLUMN group_id TEXT REFERENCES onedrive_share_groups(id);
CREATE INDEX IF NOT EXISTS idx_onedrive_drive_publications_group ON onedrive_drive_publications(group_id);

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
CREATE INDEX IF NOT EXISTS idx_onedrive_share_group_entries_parent ON onedrive_share_group_entries(group_id,parent_id,position);
