-- Stage 10: efficient lookups for recycle-bin cleanup and shared object references.
CREATE INDEX IF NOT EXISTS idx_trash_purge ON trash_entries(purge_at,space_id);
CREATE INDEX IF NOT EXISTS idx_file_object_refs ON files(object_id);
CREATE INDEX IF NOT EXISTS idx_publications_source ON publications(source_file_id,status);
CREATE INDEX IF NOT EXISTS idx_shares_target ON shares(target_type,target_id,revoked_at);
