# 第十二阶段实际测试结果与环境边界

- 验证日期：2026-10-23。
- Runtime：Linux 容器，Node.js v22.16.0，内置 `node:sqlite`（该模块在 Node 22 中仍有实验性提示）。
- 已执行：`npm run test:all`。
- 语法：50 个手写 JS 文件语法通过（不含 Bootstrap vendored min 文件）。
- 自动化：44 项 Node 单元测试全部通过；9 项 SQLite + MemoryR2 HTTP Request/Response 集成测试全部通过；11 个 SQL 迁移文件在 SQLite 内存数据库执行通过。
- 已覆盖：管理员登录与停用、Cookie/CSRF、权限拒绝、私有上传与 HTTP Range、PDF 文件签名验证、分享密码/过期/撤销、公开副本容量、9MiB Multipart、回收站物理对象最后引用删除、模拟 R2 故障重试。
- **未执行**：真实 Windows Wrangler / Miniflare D1+R2 Browser E2E；Cloudflare 在线请求/登录 CPU；CDN 自定义域名的缓存与撤销；100MB/1GB 大文件浏览器上传。
- 工具限制：尝试 `npm install` 安装 Wrangler 未成功（执行环境无法完成 npm 依赖下载）；尝试使用 Chromium 打开 HTTP、本地文件和 data URL 均被环境策略拒绝（`ERR_BLOCKED_BY_ADMINISTRATOR`）。因此绝不能声称 Chromium UI 验收通过。
- 未连接任何 Cloudflare 账户；没有执行远程 R2 桶创建、D1 迁移、Worker 部署或生产文件操作。

生产可用前，请严格执行 `docs/TEST_PLAN.md`；特别注意 Workers Free 10ms CPU 的 PBKDF2 密码派生风险。
