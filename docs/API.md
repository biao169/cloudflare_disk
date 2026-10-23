# Stage 2 API

- `GET /api/v1/health` — stage and D1 binding presence; does not imply schema migrated.
- `GET /api/v1/system/database` — D1 connection and schema readiness, no record contents.
- `GET /api/v1/dev/fixtures?limit=50&offset=0` — local test fixtures only, disabled by default.
- `POST /api/v1/dev/fixtures` — local fixture create (`id`, `username`), disabled by default.
- Other `/api/*` — 501 NOT_IMPLEMENTED.

The dev endpoints require **both** `APP_ENV=local` and `ENABLE_LOCAL_FIXTURES=true` in `.dev.vars`. Never set either in production. They create disabled placeholder users, not credentials. Stage 3 will remove/restrict these and add actual auth.

Response envelope: `{ "success": true, "data": ... }` or `{ "success": false, "error": {"code":"...", "message":"..."} }`. DB unavailability -> HTTP 503; invalid pagination -> 400.
