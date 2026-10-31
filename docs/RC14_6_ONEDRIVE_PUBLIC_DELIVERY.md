# RC14.6 — OneDrive 公开直链探测与固定入口分发

## Scope
- **No administrator token is used for public download verification.** An independently unauthenticated GET request is made to `https://api.onedrive.com/v1.0/shares/{shareToken}/root/content` with redirects disabled. A successful Microsoft file-host `Location` in a 3xx response is the only allowed direct-download response.
- The `api.onedrive.com` endpoint is a **best-effort legacy compatibility probe**, not a guaranteed Microsoft Graph anonymous API. Some valid Microsoft personal and all/most business share links may not be supported. A negative result does not prove the share is private.
- Unauthorized/private share links never receive Graph-admin-derived preauthenticated URLs via public routes.
- Existing `/r/od_*` links remain `source_page_redirect`. Owners can opt in to `public_direct` mode using PATCH. On probe failure or throttling, requests fall back to the source share page.
- The public-check API is `POST /api/v1/tools/onedrive/public-check` with `{ "url": "https://1drv.ms/..." }`. It uses the same tool access switches and quotas as format parsing.
- Responses and redirect targets use `Cache-Control: no-store, private`; temporary URLs are neither persisted to D1 nor logged. HEAD does not issue third-party probes.

## Database migration
Execute `migrations/0026_rc14_6_onedrive_public_delivery.sql` before deploying the Worker. It adds `delivery_mode` to the existing fixed-link table, preserving existing behavior by default.

## Admin and user workflow
1. Administrator retains control of tool enabled/anonymous allowed settings; if anonymous use is off, public-check requires CloudDrive login.
2. Logged-in users create fixed links, then choose **尝试公开直链** beside their fixed link.
3. For public files where independent probing yields a validated Microsoft temporary download URL, `/r/od_*` performs a 302 redirect to the actual file. It revalidates each GET and does not reuse temporary links.
4. When the probe is unavailable, fallback is a 302 to the original OneDrive share URL, **not** a file download.

## Limitations and security
- No real Microsoft account or production OneDrive link was accessed in the local tests. This release cannot promise direct-link success for arbitrary links or enterprise accounts.
- No attempt is made to bypass a password, organizational authentication, or download-disabled Microsoft share.
- Microsoft may retire/change the legacy anonymous endpoint at any time. Return status and fallback behavior are intentionally conservative.
- OAuth token renewal, authenticated administrator Graph metadata lookup and private file authorization remain independent from public route behavior.
- For strong uptime guarantees, explicitly copy an authorized file into CloudDrive R2 rather than treating the Microsoft download URL as permanent.
