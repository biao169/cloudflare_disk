# 第十二阶段增量变更（相对 Stage 11）

## 增量代码

- `migrations/0011_integrity.sql`：持久化清理队列、状态索引；对历史公开副本做一次性配额补记。
- `worker/services/cleanup.js`：R2 删除与 D1 释放配额分离，任何单边失败可在 Cron 重试。
- `worker/services/security-headers.js`：受保护 HTML 页面 CSP/no-store/referrer/frame 防护。
- `worker/services/storage.js`、`sharing.js`：文件签名基础校验、公开发布预留空间并计费、限次下载与 Range 的一致行为。
- `worker/services/trash.js`：尊重管理员保留天数，永久删除时通过 outbox 清理最后一个物理对象引用，阻止仍有上传会话的目录物理清理。
- `worker/api/admin.js`：一致性诊断暴露 pending cleanup 和 stalled uploads（只读），包括公开副本物理容量。
- `worker/index.js`、`wrangler.jsonc`：健康版本 Stage 12；页面优先 Worker 路由与安全头；Cron 重试清理任务。
- `tests/integration/`：真实 SQLite 执行 11 个 SQL 迁移文件，MemoryR2 模拟请求级操作的端到端 API 验证。
- `scripts/`：Windows 预检、远程迁移、数据库导出备份与部署确认。
- `.github/workflows/deploy.yml`：手动部署模式，测试通过才部署，不自动修改生产 D1。
- 文档重写 README，新增部署/验收/运维/安全说明。

## 测试及剩余工作

- 44 项原有测试通过，9 项 SQLite + 模拟 R2 请求级测试通过；11 个迁移文件实际在 SQLite 执行。
- 当前环境 npm 安装 Wrangler 未成功、浏览器被运行环境限制；**未完成 Windows Wrangler 浏览器测试，也未连接或部署到 Cloudflare 实际账户**。
- 上线仍需按 `TEST_PLAN.md` 确认 Workers Free CPU、真实 D1/R2 Binding、浏览器预览、100MB+ 分片、CDN 缓存和身份边界。
