-- RC14.6: opt-in best-effort independent public download routing.
-- Existing links continue to redirect to the original Microsoft share page.
ALTER TABLE onedrive_fixed_links ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'source_page_redirect' CHECK(delivery_mode IN ('source_page_redirect','public_direct'));
