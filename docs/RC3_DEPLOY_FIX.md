# RC3 Deployment Fix — 2026-10-24

## What the user's Cloudflare log actually proves

`Uploaded 23 of 23 assets`, `PRIVATE_BUCKET provisioned`, `PUBLIC_BUCKET provisioned` and the Binding list are successful deployment **intermediate steps**, not a failure. The excerpt stops at `PUBLIC_BASE_URL ("")`, before the final deployment result. The empty `PUBLIC_BASE_URL` is allowed: `/p/{id}` handles public links through the Worker.

Because the failure line is absent, the specific Cloudflare error **cannot be established from this log alone**. This patch addresses concrete first-deployment configuration and observability gaps observed in the RC2 source; it is not proof that the unseen error has been resolved.

## Verified RC2 source gaps and RC3 fixes

1. `wrangler.jsonc` contained a dummy `database_id` (`00000000-...0001`). Removed the dummy ID so Wrangler 4.45+ automatic provisioning can assign or reuse a real D1 binding. Review existing production D1 identity before deploying this change. **Do not replace a database containing real data.**
2. The RC2 `deploy` script applied D1 migrations before executing Wrangler's first deploy. When resources are provisioned by `wrangler deploy`, that order may fail for a brand-new account. RC3 checks whether the remote D1 can list migrations: existing D1 → migrate before deploying; first-time missing D1 → provision/deploy first, then migrate. Explicit `npm run deploy:initial` and `npm run deploy:upgrade` scripts are available.
3. `/api/v1/health` checked only Binding presence and could return HTTP 200 before D1 migrations. Added `/api/v1/health/ready` (503/200) to check required schema tables, D1 migration tracking, necessary Bindings, admin initialization and bootstrap-secret presence without exposing token values.
4. Added a real-repository one-click URL, Cloudflare Build/Deploy command details, and a troubleshooting decision table.
5. Added tests for deployment ordering and readiness states.

## Required Cloudflare dashboard setting

* **Build command**: blank (no Vue, Vite or frontend compiler)
* **Deploy command**: `npm run deploy` (not just `npx wrangler deploy`, which skips the application-defined migration step)

This setting is managed in Cloudflare Workers & Pages → Worker → Settings → Builds. Rerun the deployment after saving the setting.

## Post-deployment checklist

1. Do **not** recreate R2 buckets that have already been provisioned.
2. Visit `/api/v1/health/ready` and follow its `code`/`next_action`.
3. For `D1_MIGRATIONS_REQUIRED`, verify the D1 Binding and run `npx wrangler d1 migrations apply DB --remote` against the correct database; **back up first if data exists**.
4. For `BOOTSTRAP_SECRET_REQUIRED`, set a strong `BOOTSTRAP_TOKEN` Worker Secret (not a plain variable committed to Git).
5. For `ADMIN_SETUP_REQUIRED`, create the first super-admin at `/login`.
6. For `READY`, continue browser tests, password CPU testing, uploads, previews and access-control checks.
7. **Look at the log after the Binding list**. A successful upload and automatic R2 creation do not guarantee the final build/deploy succeeded.

## Validation in this environment

* `npm run check`: JavaScript syntax passed.
* `npm test`: 49 tests passed.
* `npm run test:integration`: 18 tests passed.
* Includes runner-sequence tests using a fake npm binary; no real Cloudflare API or Wrangler was available in this execution environment.
