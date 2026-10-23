# 第九阶段：文件分享

## 模式

- **分享页面**：`/s/{64位十六进制随机码}`。私有 R2 对象，不直接公开；可设置 12 位以上密码、到期时间。
- **临时授权直链**：`/t/{随机码}`，仅文件，绕过登录但仍通过 Worker 读取私有 R2；推荐设置到期时间。
- **永久公开直链**：需要超级管理员、PUBLIC_BUCKET 和 `PUBLIC_BASE_URL`（真实 HTTPS 的 R2 自定义域名）。复制到公开桶单独发布，撤销后可能仍有 CDN 和浏览器缓存。

## API

- `POST /api/v1/shares` ：`{type:'page'|'temporary',target_type:'file'|'folder',target_id,expires_at,password?,allow_download?}` 返回分享 URL；文件夹仅可选 page。
- `GET /api/v1/shares` ：列出自己创建的分享（不返回原始随机码）。
- `DELETE /api/v1/shares/:id` ：撤销分享。撤销后新访问失效。
- `GET /api/v1/public/shares/:code` ：分享元数据，需密码的分享返回 401。
- `POST /api/v1/public/shares/:code/verify` ：密码验证，设置 30 分钟 HttpOnly Cookie。
- `GET /api/v1/public/shares/:code/contents[?folder_id=...]` ：受限目录列表。
- `GET /api/v1/public/shares/:code/files/:fileId/preview|content` ：受限预览和下载，支持 Range。
- `POST /api/v1/publications` ：`{file_id}`，超级管理员发布公开文件。
- `GET /api/v1/publications` / `DELETE /api/v1/publications/:id` ：公开发布管理。

## 安全和限制

- 私有桶不得绑定公开域名；分享文件由 Worker 执行权限检查。
- URL 是 bearer token，复制给他人即授权他人访问。避免把 Token 写入分析日志或外部 Referer。
- 密码用 PBKDF2-SHA256 哈希存储。按 `分享 ID + IP` 粗粒度限流；生产前建议叠加 WAF Rate Limiting。
- 不支持将密码与临时直链直接结合：请使用分享页面。
- 永久公开副本不承诺瞬间彻底撤销。要清理自定义域名的 Cloudflare CDN 缓存。
- V1 文件夹分享通过 D1 递归检查文件所属目录；每次最多返回 200 项，不支持递归批量打包。
- V1 分享管理列表不会重复展示完整 Token；丢失链接时应撤销并重新生成。
- 此阶段仍需 Windows Wrangler + D1 + R2 集成测试，特别是密码 Cookie、Range、公开桶与缓存。
