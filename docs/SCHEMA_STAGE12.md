# Stage 12 Schema 备注

本阶段升级迁移文件：`migrations/0011_integrity.sql`。新增 `storage_cleanup_jobs` 表（保存孤立物理对象待清理任务、引用对象 key、桶类型、空间/字节数和错误计数），以避免 R2 先删失败后 D1 记录永久丢失。

迁移同时为 `storage_objects` 状态和异常 `upload_sessions` 添加索引，并一次性补记 Stage 11 以前公开发布的 `ready` 副本到所属空间 `used_bytes`。如果你手动修改过旧版 `used_bytes`，请在应用迁移前先核对以免重复统计。迁移只执行一次，后续发布/撤销由 Worker 自行更新容量。

管理员 `/api/v1/admin/reconcile` 为只读检查，其中 `referenced_bytes` 包含私有对象的去重引用和公开副本；`cleanup_pending` 为待删除对象，`stalled_uploads` 为可能已经完成 R2 对象但 D1 未确认的会话。不能把这些数字直接当作 Cloudflare 账单。
