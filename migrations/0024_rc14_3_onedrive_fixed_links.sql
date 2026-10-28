-- RC14.3: fixed OneDrive entry links, never store a preauthenticated download URL.
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
);
CREATE INDEX IF NOT EXISTS idx_onedrive_fixed_links_owner ON onedrive_fixed_links(created_by,created_at DESC);
