# RC13.5 旧 CDN 兼容、重试与容量联调

- `/r/{id}` 每个新请求读取公开发布指针；缓存策略仍是 `no-store`。
- 旧 `published/*` 别名通过 `publication_sync_jobs` 同步。失败任务增加 `next_retry_at` 指数退避（上限约一小时）；不自动将缓存未确认判定为全球更新完成。
- `file_versions` 的对象引用受删除保护，维护 Cron 仅清理 7 天前且不属于当前文件、至少存在 1 个较新历史修订的记录。每轮最多 1 个，物理删除失败保留清理队列。
- `/api/v1/admin/version-operations` 为只读运维报告：同步任务、历史版本逻辑容量、清理待办与空间账本。历史引用可能共享同一对象，报告不等同于 Cloudflare R2 账单。
- 生产升级先备份 D1/R2，部署命令保持 `npm run build` / `npm run deploy`；0022 迁移为新增字段与索引，不需要新 Secret。
- 本次没有提供恢复或清理旧 CDN 浏览器缓存的强一致性保证；未配置 `CDN_PURGE_TOKEN` 时会提示无法确认缓存状态。
