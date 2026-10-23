# Windows development · Stage 2

1. Install Node.js LTS, run `npm install` in PowerShell or CMD at project root.
2. Run `scripts\migrate-local.bat` (or `npm run db:migrate:local`).
3. Optional demo fixture: `scripts\seed-local.bat` (or `npm run db:seed:local`).
4. Start `scripts\dev.bat` or `npm run dev`, open `http://localhost:8787/files`.
5. Inspect `http://localhost:8787/api/v1/system/database` for `schema_ready: true`.
6. Test with `scripts\test.bat` or `npm test` and `npm run check`.
7. Local D1 is stored in `.wrangler/state` and does not use production resources.

Do not use `--remote` during local development. Database ID in configuration is a **local development placeholder**. For production create a real D1 database and insert its UUID. Stage 2 is **not** publicly deployable due to missing auth. Demo list in front end remains static stage-1 data.
