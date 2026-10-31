# RC14.4 — Microsoft administrator OAuth integration

This milestone adds an **administrator-only** Microsoft OAuth connection and a Graph-backed sharing URL resolver. It does not silently publish private Microsoft files to visitors; public `/r/od_*` links still open the original sharing page.

## Azure configuration

1. Open Microsoft Entra admin center > App registrations and create an app supporting personal Microsoft accounts (or both organizational and personal accounts).
2. Register a **Web** redirect URI exactly `https://YOUR_CLOUDDRIVE_HOST/api/v1/admin/onedrive/oauth/callback`.
3. Add delegated Microsoft Graph permission `Files.ReadWrite` (required for the Graph Shares endpoint) and `User.Read`. Requesting `offline_access` obtains a refresh token. Review permissions and tenant consent carefully.
4. Set Worker vars `MS_CLIENT_ID` (application/client ID) and optionally `MS_TENANT` (defaults to `common`). Set secret `MS_CLIENT_SECRET` for confidential web app token exchange, and `MS_TOKEN_KEY` as **32 random bytes (64 hexadecimal characters recommended, or 32-byte Base64)**; keep a backup in a secure secret vault. See [config diagnosis](RC14_7_MICROSOFT_CONFIG_FIX.md) for runtime binding checks and distinct error codes.
5. Apply migration `0025_rc14_4_onedrive_oauth.sql` before deployment.
6. Log into CloudDrive as super administrator; open `/tools/onedrive`, connect Microsoft and authorize. Resolve the source URL from the same administrator-only panel.

## Security and limitations

- OAuth state and PKCE verifier are stored in D1 with a 10-minute expiry and are bound to the current administrator. Background cleanup is recommended.
- Access and refresh tokens are encrypted using AES-256-GCM and `MS_TOKEN_KEY` in D1. Losing the key requires reconnecting. Do not rotate it without a migration.
- Never expose the `/api/v1/admin/onedrive/graph/resolve` response to unauthenticated users. Its `download_url` is a short-lived bearer-like download capability.
- Refresh token may be revoked or expire. Admin must reconnect when needed.
- Files.ReadWrite is broader than read-only; Microsoft Graph Shares API lists it as the least privileged delegated permission for shared items. Avoid using this authorization to bypass the source file sharing permissions.
- This release DOES NOT upgrade existing `/r/od_*` redirects into direct downloads. Public direct-download eligibility verification and secure per-link opt-in are deferred to a subsequent milestone.
- No live Microsoft tenant was connected during local validation.
