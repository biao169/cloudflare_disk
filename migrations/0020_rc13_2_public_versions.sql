-- RC13.2: immutable public versions and a stable Worker resolver.
-- Existing published/<id> R2 paths remain as compatibility aliases.
ALTER TABLE publications ADD COLUMN published_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publications ADD COLUMN legacy_object_id TEXT REFERENCES storage_objects(id);
ALTER TABLE publications ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'ready'
 CHECK(sync_state IN ('ready','alias_pending','purge_pending','failed','cache_unverified'));
ALTER TABLE publications ADD COLUMN auto_sync INTEGER NOT NULL DEFAULT 1 CHECK(auto_sync IN (0,1));
UPDATE publications SET legacy_object_id=public_object_id WHERE legacy_object_id IS NULL;
CREATE TABLE publication_versions (
 id TEXT PRIMARY KEY,
 publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
 file_revision INTEGER NOT NULL CHECK(file_revision>=0),
 object_id TEXT NOT NULL REFERENCES storage_objects(id) ON DELETE RESTRICT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(publication_id,file_revision)
);
-- Legacy copies existed before the app tracked public file revision.
INSERT OR IGNORE INTO publication_versions(id,publication_id,file_revision,object_id)
 SELECT lower(hex(randomblob(16))),p.id,0,p.public_object_id FROM publications p;
CREATE INDEX idx_publication_versions_latest ON publication_versions(publication_id,file_revision DESC);
CREATE TABLE publication_sync_jobs (
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
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(publication_id,file_revision)
);
CREATE INDEX idx_publication_sync_jobs_due ON publication_sync_jobs(status,created_at);
