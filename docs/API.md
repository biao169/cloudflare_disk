# Stage 2 API

- `GET /api/v1/health` — stage and D1 binding presence; does not imply schema migrated.
- `GET /api/v1/system/database` — D1 connection and schema readiness, no record contents.
- `GET /api/v1/dev/fixtures?limit=50&offset=0` — local test fixtures only, disabled by default.
- `POST /api/v1/dev/fixtures` — local fixture create (`id`, `username`), disabled by default.
- Other `/api/*` — 501 NOT_IMPLEMENTED.

The dev endpoints require **both** `APP_ENV=local` and `ENABLE_LOCAL_FIXTURES=true` in `.dev.vars`. Never set either in production. They create disabled placeholder users, not credentials. Stage 3 will remove/restrict these and add actual auth.

Response envelope: `{ "success": true, "data": ... }` or `{ "success": false, "error": {"code":"...", "message":"..."} }`. DB unavailability -> HTTP 503; invalid pagination -> 400.

## RC7：文件浏览、目录选择与批量管理

以下接口在既有 `/api/v1` 路由体系上追加，不需要修改旧分享令牌或 R2 对象 Key。

- `GET /api/v1/files/recent?limit=30&cursor=` — 最近文件，跨有权访问的空间、按更新时间降序、带权限过滤和游标分页。
- `GET /api/v1/spaces/{spaceId}/folders?parent_id=&offset=0&limit=50` — 目录选择器使用，返回 `items[].can_write`、`parent_writable`、`root_writable`、`has_more`；只有可读子目录才会出现在列表。
- `GET /api/v1/spaces/{spaceId}/contents?parent_id=&offset=0&limit=50&sort=name_asc&filter=all` — 排序支持 `name_asc` / `name_desc` / `updated_desc` / `size_desc`；类型支持 `all` / `images` / `videos` / `documents` / `other`。
- `POST /api/v1/files/batch`，请求体 `{ "operation":"move|copy", "file_ids":[], "folder_ids":[], "target_folder_id":null }` — 最多 20 项。目录批量移动支持；目录批量复制不支持。逐项返回 `{ id,kind,status,success,error }`。
- `POST /api/v1/trash/batch`，请求体 `{ "items":[{"kind":"file|folder","id":"..."}] }` — 最多 20 项，逐项检查目录访问控制并返回独立结果。
- `GET /api/v1/shares` 返回 `target_name` 以支持分享记录的正常展示，但不返回任何原始明文令牌。

所有新增接口都必须具有有效登录会话；对用户提交的文件、目录和空间 ID，后端继续执行 ACL 校验。请参见 [RC7 文件交互规格](RC7_FILE_EXPERIENCE.md)。


## RC9 运维与备份（super_admin）

- `GET /api/v1/admin/dashboard`：容量、预留、分享、维护状态和预警。
- `GET /api/v1/admin/maintenance/runs`、`POST /api/v1/admin/maintenance/run`：历史及手动清理。
- `GET /api/v1/admin/operations/events?page=1&limit=30`、`POST /api/v1/admin/operations/events/:id/ack`：脱敏聚合异常和确认。
- `GET /api/v1/admin/backups/manifest`：下载元数据清单（**不能用于恢复**）。
- `GET/POST /api/v1/admin/backups/records`：手动备份登记（不等于校验完成）。

Windows 真正的 D1+R2 备份与恢复见 [RC9_OPERATIONS.md](RC9_OPERATIONS.md)。
