# CloudDrive 运维与故障恢复

## 日常巡检

- 后台 `/settings`：查看已用、预留、分享数、最近审计操作。
- 管理员只读 API `/api/v1/admin/reconcile`：比较 D1 记录与引用对象逻辑容量，查看 `cleanup_pending` 和 `stalled_uploads`。
- Cloudflare Dashboard：查看 Workers 请求/CPU、D1 读写行、R2 容量与请求量以及账单提醒。**应用账面数字不代表 Cloudflare 官方计费。**

## 定时清理

每天 UTC 03:00 由 `wrangler.jsonc` 配置的 Cron 触发：

1. 清理过期 Multipart 上传会话（普通 `uploading`）。
2. 清理到期回收站记录。
3. 重试 `storage_cleanup_jobs` 中待删除的 R2 对象，并仅在 R2 与 D1 都成功后释放应用账面容量。

限额每轮清理一部分，超大量积压可能需要多次 Cron；不要随意删除队列表中的失败记录，否则可能永久遗失孤立对象线索。

## 常见故障

- **登录失败 / 500**：检查 D1 Binding、迁移、密码哈希 CPU；生产环境不要打印令牌和密码。
- **只有文件元数据、无法下载**：查 `storage_objects` 与 R2 Key，切勿直接在 D1 中删除记录伪装恢复。
- **分片合并后出错**：先看 `upload_sessions` 状态、R2 对象和 reserved_bytes；`failed/verifying` 会话可能已写入 R2，不能直接重试完成或删掉。
- **公共 URL 无法访问**：确认公开桶 Custom Domain 已绑定且 HTTPS；确认 `PUBLIC_BASE_URL` 与域名一致，并验证对象 Key。
- **撤销后 CDN 仍访问**：到 Cloudflare 进行缓存清理，检查浏览器缓存；文件曾被他人下载的副本无法回收。
- **空间容量统计不准**：先运行只读 reconcile，核对跨文件引用、回收站、正在进行的上传和历史公开副本。不得直接 SQL 修改 used_bytes，除非先备份并逐项核对 R2。
- **D1 免费配额耗尽**：避免反复刷新全目录或使用重型搜索，等待配额窗口重置；不要通过放开私有桶来绕过 Worker 限额。

## 备份和升级

- **D1 元数据**：`npx wrangler d1 export clouddrive-db --remote --output=backup.sql`。导出 SQL 不包含 R2 文件内容。大规模导出可能阻塞部分数据库请求，选择低峰时段。
- **R2 内容**：需要额外使用 Cloudflare/S3 兼容的对象备份方案。项目源码、D1 与 R2 都需要独立备份策略。
- **本地**：完整备份 `.wrangler/state`，不要把测试本地状态误当生产备份。
- **部署**：备份 -> 验证待迁移 -> `d1 migrations apply --remote` -> `wrangler deploy` -> 验收；历史恢复时数据库和 R2 版本要对应。

## 免费账号开销提醒

Workers Free 每日请求有硬限额；R2 免费容量是按月 GB-month 结算，且可能需要绑定支付方式。大量视频下载优先走独立公开 R2 域名，私密内容始终通过 Worker 鉴权并遵守限额。
