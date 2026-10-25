# CloudDrive RC9 — 生产运维、备份与恢复

## 0. 发布边界（先读）

- 仅在原有 Worker `cloudflare-disk`、D1 `clouddrive-db`、R2 `clouddrive-private` / `clouddrive-public` 上更新；不新建生产副本，不清空任何桶。
- 新迁移 `migrations/0015_rc9_operations.sql` **只增加**维护锁、运行历史、异常记录和备份登记四张表、索引；不重建原表，不修改用户密码/文件/分享数据。
- Cloudflare Dashboard → **Settings → Builds**：Build `npm run build`，Deploy `npm run deploy`。部署脚本会自动匹配现有数据库并先执行增量迁移。
- Worker Runtime Secrets `BOOTSTRAP_TOKEN`、`SHARE_LINK_KEY`、`CDN_PURGE_TOKEN`（如已使用）保持原值；不要在部署时更新密码或加密密钥。
- 任何生产 D1 迁移前都应尽量先完成**独立的** D1+R2 备份。D1 schema 迁移自动备份不等于 R2 对象备份。
- `/api/v1/health/ready` 回 `READY` 仅说明基础环境与管理员就绪，不代表 R2 的物理对象核验完毕。

## 1. 管理员仪表盘 `/settings`

五个操作区域：容量与核对、自动清理、异常日志、备份与恢复、站点设置。

- **全局与空间配额**：显示 `used_bytes`、`reserved_bytes`、文件数量、有效分享和各空间额度。应用上限默认 **8 GiB**，告警阈值默认 **85%**，均可调整。自定义空间配额输入单位为 MiB；`0` 表示继承全局限制。
- **预警**：接近全局/空间上限、待清理 R2、失败上传、未确认异常、超过提醒期限的备份登记和暂停维护。
- **D1 容量账本核对**：只读，能发现业务元数据偏差。私有/公开 R2 扫描每页最多 50 个对象，仍不会更改/删除异常对象。
- **存储统计≠Cloudflare 账单**：D1 账本不是完整 R2 GB-month/操作计费，也不代表 Workers 今日请求量；以 Cloudflare Dashboard 为准。
- **异常日志**：只持久记录来源、错误码、首次/末次出现时间、次数及管理员确认状态；不保存明文 Token、文件名、请求体、堆栈。查看具体异常请到 Cloudflare Dashboard → Worker → Observability/Logs。

管理员 API：

| 请求 | 用途 |
|---|---|
| `GET /api/v1/admin/dashboard` | 真实容量摘要、健康与预警 |
| `GET/PATCH /api/v1/admin/settings` | 站点设置、告警和保留期限 |
| `PATCH /api/v1/admin/spaces/:id/quota` | 空间额度 |
| `GET /api/v1/admin/operations/events?page=1&limit=30` | 脱敏错误列表 |
| `POST /api/v1/admin/operations/events/:id/ack` | 确认事件 |
| `GET /api/v1/admin/maintenance/runs` | 历次 Cron/手动运行结果 |
| `POST /api/v1/admin/maintenance/run` | 手动执行一轮带维护锁的清理 |
| `GET /api/v1/admin/backups/manifest` | 下载只读**元数据清单，不能用于恢复** |
| `GET/POST /api/v1/admin/backups/records` | 手动登记外部备份；系统无法核验文件存在 |
| `GET /api/v1/admin/reconcile` | 只读 D1 容量账本检查 |
| `GET /api/v1/admin/reconcile/objects?bucket=private&limit=50` | 只读分页 R2 物理对象检查 |

所有 `/api/v1/admin/*` 接口需要 **super_admin** 登录；修改接口还需要同源校验。前端访问时 Cookie 自动带上。

## 2. 定时自动清理

`wrangler.jsonc` 的 Cron 改为 `0 */6 * * *`，**UTC 每 6 小时**执行一次。Cloudflare 免费账户最多 5 个 Cron Trigger；本项目只用 1 个。

- D1 `maintenance_lock` 单条租约（5 分钟）控制并发；任务重叠则跳过，不会同时删除同一个对象。
- 一次最多选 2 个过期分片会话、2 个待清理 R2 对象、1 个回收站记录；回收站文件每轮最多清理 2 个、文件夹每轮最多 3 个，保留未完成的回收站记录以便下轮续跑。
- 已经触发 R2 删除且尚未完成 D1 清理的持久化任务可安全重试；不自动删除未确认为孤立的对象。
- 异常事件历史默认保留 30 天（可设置 7–90 天）；运行历史保留 90 天，每轮最多清理少量旧记录。
- 管理员可暂停自动 Cron（`maintenance_paused`），手动发起维护仍可运行；长期暂停可能导致容量堆积。
- Cloudflare R2 自身的默认生命周期会在 **7 天**后中止未完成 Multipart Upload；不能代替应用层释放 D1 预留容量。

大目录删除将分多次运行；不要人为强迫“一次彻底清空”以免超过免费 Worker 的 50 次子请求/10ms CPU 预算。

## 3. 备份（务必同时导出 D1 和两个 R2 桶）

### A. D1 免费 Time Travel

D1 免费计划提供最多 **7 天**时间点恢复窗口（默认开启），但恢复是**覆盖目标 D1 的破坏性操作**；R2 文件完全不在范围内。常用查看命令：

```powershell
npx wrangler d1 time-travel info clouddrive-db
```

请不要在没有独立备份及停写计划的情况下执行 `time-travel restore`。

### B. Windows 完整备份（真正导出文件）

在 Windows 项目根目录运行：

```powershell
npm install
# 先执行 wrangler login 并用 rclone config 配置名为 r2 的 Cloudflare R2 S3 remote
powershell -ExecutionPolicy Bypass -File .\scripts\backup-production.ps1 -R2Remote r2
```

脚本会：

1. `node scripts/deploy-cloudflare.mjs --backup-only` 从**现有**远程 D1 导出 SQL；
2. `rclone copy` 将 **私有桶和公开桶** 的完整对象复制到 Windows 备份目录（不删除远程）；
3. 对两个桶分别进行文件名、数量及大小基础核验（`--size-only`，**不是加密哈希完整性验证**）；
4. 为 D1 SQL 计算 SHA256，生成 `manifest.json`；完成的备份位于 `backups/clouddrive-YYYYMMDDTHHMMSSZ/`。

可以通过 `-D1Only` 只导出 SQL，但此种产物**不能独立还原网盘**。

**限制：** D1 SQL 导出与 R2 对象复制不是跨服务原子快照。如果用户在备份期间上传、删除或发布文件，SQL 与 R2 可能不一致。重要备份应安排维护窗口，暂时停止写入并在备份后进行恢复验证。

### C. 可选 Windows 定期完整备份

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-backup-task.ps1 -R2Remote r2 -At 03:30
```

需要 **电脑开机且已登录适用的 Cloudflare / rclone 凭据**，Windows Task Scheduler 才能按本地时区每天运行。此功能不是 Cloudflare Worker 在后台直接将文件备份到你的 Windows 电脑。该任务可能需要当前 Windows 账户的调度权限。

**备份保密：** SQL 包含用户登录哈希、空间权限及分享数据；R2 包含私有文件。请使用加密磁盘、独立离线或异地副本，避免将 `backups/` 提交 Git（已在 `.gitignore` 中排除）。

### D. 隔离恢复（默认只做检查）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-production.ps1 -BackupDirectory '.\backups\clouddrive-YYYYMMDDTHHMMSSZ'
```

脚本将检查备份格式和 D1 SQL SHA256，**不会修改任何线上数据**。

实际恢复时，必须先在 Cloudflare **新建独立的空 D1 数据库及两个空的 R2 存储桶**，然后手动提供新名称和确认口令：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-production.ps1 `
 -BackupDirectory '.\backups\clouddrive-YYYYMMDDTHHMMSSZ' `
 -R2Remote r2 `
 -NewDatabase clouddrive-restore `
 -NewPrivateBucket clouddrive-private-restore `
 -NewPublicBucket clouddrive-public-restore `
 -Apply -Confirm ISOLATED-RESTORE
```

此模式首先验证恢复目标 R2 桶为空、D1 数据库为空，再尝试导入 SQL、复制文件并校验。**不会自动替换生产 Worker 的任何 Binding，也不允许使用既有生产数据库或桶名**。真实恢复还应检查文件读写、权限、对象映射和账号登录后，再制定人工切换计划。

## 4. 生产部署与兼容性

1. 可先导出完整 D1/R2 备份（重要数据尤其建议）。
2. 在已有 GitHub 仓库推送 RC9，保留现有 `wrangler.jsonc` 的 Worker 名称、D1 ID 与 R2 Binding、自定义 CDN 域名；更新 `APP_STAGE` 为 `rc9-operations`。将 Cron 更新到 `0 */6 * * *`（若已自行定义其他定时任务，则人工检查）。
3. Cloudflare Builds 保持 `npm run build` 与 `npm run deploy`；发布脚本会自动运行新增的 `0015_rc9_operations.sql`，保留旧数据。
4. 部署后查看 `/api/v1/health/ready`、登录 `/settings`；观察新的后台概览及 Cron 任务历史。
5. Worker 发布失败应先回滚代码；**数据库迁移、已删除的 R2 对象不随代码回滚**。

旧的 `/api/v1/admin/uploads/recover` 已改用同一个维护锁，但响应仍提供 `uploads`、`storage` 字段以兼容旧前端。

## 5. 不能误以为已经实现的能力

- 后台不自动、也无法可靠获取 Cloudflare 账户的精确计费或每日剩余额度。请在 Cloudflare Billing/Analytics 检查。
- 元数据清单和备份**登记**不能作为恢复依据；只有实际 SQL 文件 + 两桶文件、离线存储和恢复演练才具有恢复价值。
- Worker Cron 不会把文件自动存储到用户的 Windows 硬盘；要做到自动离站备份，需 Windows Task Scheduler 或额外独立备份设施。
- RC9 不自动重算覆盖账本，也不自动删除扫描中“未跟踪”的 R2 文件。
