-- RC14.9: presentation metadata for already explicitly published OneDrive files.
-- Additive, preserves all existing odf_* ids and /r/odf_* links.
ALTER TABLE onedrive_drive_publications ADD COLUMN title TEXT;
ALTER TABLE onedrive_drive_publications ADD COLUMN description TEXT;
ALTER TABLE onedrive_drive_publications ADD COLUMN display_name TEXT;
ALTER TABLE onedrive_drive_publications ADD COLUMN cover_style TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE onedrive_drive_publications ADD COLUMN cover_key TEXT;
ALTER TABLE onedrive_drive_publications ADD COLUMN cover_mime TEXT;
ALTER TABLE onedrive_drive_publications ADD COLUMN preview_enabled INTEGER NOT NULL DEFAULT 1 CHECK(preview_enabled IN (0,1));
ALTER TABLE onedrive_drive_publications ADD COLUMN file_size INTEGER;
ALTER TABLE onedrive_drive_publications ADD COLUMN file_mime TEXT;
ALTER TABLE onedrive_drive_publications ADD COLUMN file_modified_at TEXT;
