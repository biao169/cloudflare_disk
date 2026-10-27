# RC11 安全性与 Cloudflare 免费额度优化

## 本版范围

基线是 CloudDrive RC10。保留 Worker `cloudflare-disk`、现有 D1 `clouddrive-db`、私有/公开 R2 桶和全部旧版分享 URL。仍使用原生 HTML/Bootstrap/JavaScript，无须前端编译。

| 文件 | 变更 |
| --- | --- |
| `worker/services/permission-batch.js` | 新增同请求内有界、无跨请求缓存的批量 D1 ACL 查询，保留最近匹配 ACL、用户优先于角色 ACL 的语义 |
| `worker/api/file-browser.js`、`files.js` | 最近文件、文件夹选择、文件列表与搜索使用批量 ACL，避免 N+1 查询 |
| `worker/services/share-management.js`、`worker/api/shares.js` | 多条已有分享统一批量计算状态；公开文件夹下子目录 ACL 批量检查 |
| `worker/api/files.js` | 文件复制要求源文件可读；跨目录移动要求删除权限；移动文件夹改变继承权限时要求空间管理员明确确认 |
| `public/js/modules/file-manager.js`、`public/js/api.js` | 文件夹移动收到 `ACL_CHANGE_CONFIRMATION_REQUIRED` 时弹出确认，批量目录移动也提示；API 错误保留机器码供 UI 使用 |
| `worker/services/trash.js` | 单条 SQL 绑定参数分组至最多 70 项（D1 每条最多 100 参数），包括删除、快照、恢复、批量 ACL、回收站列表 |
| `worker/services/sharing.js` | 达到 max_downloads 后禁止所有新的密码已验证分享访问，包括预览和目录浏览；GET 下载计数仍使用原子条件 UPDATE |
| `worker/api/shares.js` | 分享密码失败计数仅在 15 分钟窗口内累积，超时后重新开始计数 |
| `worker/api/auth.js`、`services/auth.js` | 登录保留账号+IP 限流，同时新增哈希化的按来源 IP 30 次/15 分钟限制，降低大量用户名轮换攻击的影响 |
| `worker/services/operations.js` | Cron 与管理员手动运维维护锁下分批清理过期认证记录，不删除有效会话 |
| `migrations/0017_rc11_security_performance.sql` | 仅添加安全清理与最近文件检索相关索引，不改旧用户、文件或分享表数据 |
| `scripts/check-migrations.mjs` | 构建阶段静态检查危险 DROP/DELETE 等迁移语句。此检查不是迁移完整性证明或备份替代品 |

## 重要行为变更

**移动文件夹：** 编辑者仍可重命名具有写权限的文件夹，但跨父目录移动将返回 403；空间管理员移动时第一次返回 409 `ACL_CHANGE_CONFIRMATION_REQUIRED`，界面确认后发 `confirm_acl_change: true`。管理员必须理解目标位置的 ACL 继承变化并在移动后检查共享范围。此处是“要求管理员明确确认”，**不是自动证明新位置的所有 ACL 不会扩大**。

**分享下载次数：** `max_downloads` 表示允许发起完整附件下载的次数。预览在剩余次数内不扣减；额度耗尽后新的预览和下载都会被拒绝。对设置 max_downloads 的文件，仍拒绝 Range 片段下载，以防一个下载被分片计成多次。已经传输到浏览器的内容无法收回，下载连接一旦开始，即使客户端中断，也可能耗用一个名额。此功能不能替代 DRM。

**登录限制：** 继续保留基于用户+IP 的 5 次/15 分钟限制；新增同 IP 总计 30 次/15 分钟的限制。只存哈希化标识、不存原始 IP 或用户名。共享公网出口可能受同一 IP 配额影响，必要时后续接入 Cloudflare Turnstile 或 WAF。

**SQL 限制：** 每次提交 200 个以内的文件/目录回收站操作会拆成最多 70 个 ID 一条 SQL。D1 Free 还有每 Worker 50 查询数限制，批量 ACL 避免大量逐项目查询。深层目录/极大搜索集合仍会产生数据库开销，不保证所有路径都在任何情况下低于 50 次调用。

## 部署和回退

1. 在生产 D1 及重要 R2 Bucket 执行可验证的备份。RC9 的 Windows 脚本可提供 D1 SQL 和双 R2 桶备份，但不要假设 D1、R2 备份之间有事务快照。
2. 更新 GitHub `main`。Cloudflare Builds 维持 **Build `npm run build`、Deploy `npm run deploy`**，将自动执行新增迁移和部署。
3. 不重新创建管理员、D1 或 R2；不更改 `BOOTSTRAP_TOKEN`、`SHARE_LINK_KEY`。
4. 打开 `/api/v1/health/ready` 检查 `READY`，然后由管理员人工检查跨目录移动、分享限次和回收站。
5. 代码问题可回滚 Worker；数据库索引迁移通常可以保留，但若涉及真实数据事故必须从独立备份恢复。生产变更前请仔细审查 Diff。

## 未覆盖的高风险事项

- 无法在本执行环境替代你账户上的真实 Cloudflare Workers Free CPU 用量、浏览器端到端或备份恢复演练。
- PBKDF2-SHA256 仍为 100,000 次、256 位输出；未降低算法强度。免费版 10 ms CPU 是否足够需看 Cloudflare 实际日志。
- 不能通过 HTTP 预览/限次限制阻止用户保存截图或已经传输的内容。
- 目录移动仍可能被空间管理员有意扩大授权；RC11 强制管理员确认而非实施 ACL 快照或自动差异算法。
- 公共 CDN 对象已经缓存的内容无法瞬时收回；请根据 R2 域名策略清理缓存。
- 本轮没有主动向你的 GitHub 推送或修改线上数据。
