# D1 Schema · Stage 2

Migrations are applied in filename order: `0001_initial.sql`, `0002_indexes.sql`, `0003_settings.sql`. Wrangler tracks applied files in `d1_migrations`.

15 core business tables plus `app_settings`: `users`, `sessions`, `spaces`, `space_members`, `folders`, `folder_permissions`, `files`, `storage_objects`, `upload_sessions`, `upload_parts`, `shares`, `share_access`, `publications`, `trash_entries`, `audit_logs`, `app_settings`.

Database only holds metadata. Password hashes and share hashes are placeholders for stages 3 and 8. `target_id` in polymorphic `shares` and `trash_entries` must be validated by services; SQL cannot enforce a FK across two tables. Folder loops and cross-space references are checked by the business layer in stage 4/5. Folder/file uniqueness is per directory for active items. R2 and D1 are not a distributed transaction; later stages must implement reconciliation.

All timestamps use UTC text. No automatic user creation or permanent production test data at this stage.

## Local

```
npm install
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

To inspect using CLI: `npx wrangler d1 execute clouddrive-db --local --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"`.

**Production is not yet configured.** Before remote deployment create D1 using `npx wrangler d1 create clouddrive-db`, replace placeholder UUID in `wrangler.jsonc`, apply `--remote` migrations only after reviewing them, and implement authentication first.
