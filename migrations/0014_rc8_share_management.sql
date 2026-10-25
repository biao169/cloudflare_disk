-- RC8: encrypted recovery is opt-in and backwards compatible.
-- Legacy shares have NULL; their original bearer URL cannot be reconstructed.
ALTER TABLE shares ADD COLUMN link_ciphertext TEXT;
CREATE INDEX IF NOT EXISTS idx_shares_owner_target_status ON shares(created_by,target_type,target_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_publications_source_status ON publications(source_file_id,status);
