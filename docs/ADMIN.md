# 第十一阶段：系统管理与额度保护

## 新增功能
- 超级管理员 `/settings` 页面：全局容量上限、上传开关、站点名、默认分享与回收站天数。
- 空间配额管理、应用层统计、健康信息、最近审计日志。
- `/api/v1/admin/reconcile` 提供只读诊断，不自动更改数据库或 R2 对象。
- 小文件和分片上传均使用 D1 条件更新，检查所有空间 `used_bytes + reserved_bytes` 总和。

## 管理 API
- GET/PATCH `/api/v1/admin/settings`
- GET `/api/v1/admin/storage`
- PATCH `/api/v1/admin/spaces/:id/quota`
- GET `/api/v1/admin/audit-logs?limit=30&before=...`
- GET `/api/v1/admin/health`
- GET `/api/v1/admin/reconcile`

## 已知限制
- 这里显示的容量是 D1 业务账本值，**不是** Cloudflare 实时账单，也不是 R2 GB-month 数字。
- 全局上限默认 8 GiB，为应用限制，不保证绝对不会产生 R2 费用。
- `public_shares_enabled` 已在分享及公开发布创建入口应用；细粒度权限及异常流程仍需阶段十二真实集成验证。
- 审计日志当前记录设置更新与空间配额变更，尚未覆盖全部文件事件。
- `reconcile` 是只读元数据检查，不能代表物理对象实时体积或逐桶校验。
- 大量并发、Worker 与 D1 故障/回滚等情形仍需要真实 Wrangler 集成测试。
