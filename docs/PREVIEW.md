# Stage 8 — Authenticated media preview

- UI: `public/js/modules/preview.js`, `public/css/preview.css`.
- Endpoint: `GET|HEAD /api/v1/files/{uuid}/preview`. Same `resolveUser`, space and folder authorization as `/content`.
- Allowlist: image/jpeg, image/png, image/webp, image/gif, video/mp4, video/webm, application/pdf. SVG, HTML, executable and unknown types rejected with 415.
- Response: `Content-Disposition: inline`; `X-Content-Type-Options: nosniff`; `Cross-Origin-Resource-Policy: same-origin`; `Cache-Control: private, no-store`.
- Range: single byte-range (206) and invalid-range (416), inherited from Stage 6. Multi-range not implemented; browser support varies.
- Files remain in private R2 and require authenticated API calls. Cookie credentials are included for same-origin elements (image/video/iframe).
- Video is not transcoded; only browser-supported codecs can play. Existing download uses fetch+blob, which is unsuitable for very large files and should be improved later.
- Testing still needed on actual Windows Wrangler + R2 + D1: use sample JPG/GIF/MP4/WebM/PDF, test seek, 401 response, ACL denial, missing R2 object, disallowed MIME, mobile and keyboard interactions.
