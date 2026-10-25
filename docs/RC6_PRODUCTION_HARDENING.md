# RC6 生产可靠性与权限修复

> 此版本在 RC5 上增量升级。不清空 D1、不清空 R2，不重置管理员，不重新生成分享链接。自动化测试只提供回归保障，并不表示本仓库已获得生产 Cloudflare 账号的部署权限。

## 1. 修复范围

| 模块 | 修改 | 兼容性说明 |
|---|---|---|
| 空间成员权限 | 删除团队成员或降为 viewer 时，在同一个 D1 批事务中撤销该成员创建的团队临时/页面分享 | 既有分享 URL 不变，但被撤销后不可访问 |
| 分享实时鉴权 | 每次解析链接，检查创建者账号启用状态、当前空间权限和目标读/分享权限。共享目录子文件还验证创建者的实时读权限 | 旧链接在取消授权后返回 404；永久公开 R2/CDN 副本仍需管理员显式撤销和清缓存 |
| 回收站 ACL | 普通成员仅能看到本人删除且仍有相应目录写入权限的条目；空间管理员可管理整个空间。删除目录时检查子目录 ACL | 提升目录 ACL 查询效率；为单请求删除设置最多 200 项的防护阈值 |
| 回收站独立删除 | `trash_entry_items` 记录此次删除时真正仍处于活动状态的文件/目录 | 父目录恢复不会恢复此前独立移入回收站的子文件；旧版无快照记录时采取保守恢复检查 |
| R2 Multipart 恢复 | 分片合并中断后通过 R2 `head` 核对已完成的对象，再尝试补齐 D1 元数据；提供用户恢复 API 及 Cron 清理 | 不重新分配上传会话 ID；重新选择同一文件可触发恢复；无法安全入库的已完成对象排队清理，释放配额前需要实际删除成功 |
| 单次上传清理 | 正常小文件 R2 写入成功但 D1 失败时，若 R2 删除也失败，将待清理任务持久保存并继续占用预留 | 依赖 D1 可用写入清理任务；如 D1 亦故障，会保留配额并通过管理员只读扫描协助排查 |
| 流式下载 | 前端文件下载改为普通浏览器下载链接，不再调用 `response.blob()` | Worker 本来就以 `ReadableStream` 输出；响应下载不要求将全部文件读入 JS 内存 |
| 容量核对 | D1 物理文件、公开副本、待清理占用、分片预留计算账本差异；支持 R2 私有或公开桶的按游标分页只读扫描 | 不自动更改 `used_bytes`、`reserved_bytes`、Bucket 对象、分享记录 |
| 清理幂等 | 即使 Cron 重复拿到同一待清理任务，也只扣减一次容量 | 无需重建数据库 |

## 2. 新 SQL 迁移

新增 `migrations/0012_rc6_reliability.sql`：

- `trash_entry_items`：记录一次目录软删除实际涉及的文件/目录，避免误恢复另一个删除操作的内容。
- `upload_sessions.recovery_error` / `recovery_attempts`：记录分片自动恢复异常。
- `storage_cleanup_jobs.reserved_release_bytes` / `upload_session_id`：在 R2 已确认删除后释放上传预留，不提前释放物理存储配额。

迁移只新增表、列、索引，不删除旧表。**已经应用的 0001–0011 文件不应改动或重复手工执行。**

## 3. 新增和更新的 API

| 方法 | URL | 身份要求 | 说明 |
|---|---|---|---|
| `POST` | `/api/v1/uploads/:id/recover` | 任务本人 | 确认完成的 R2 对象并尝试恢复 D1 文件，失败可继续等待 Cron；不能重复生成文件 |
| `POST` | `/api/v1/admin/uploads/recover` | 超级管理员 | 每次最多检查 3 个停滞会话和 3 个待清理对象，操作有审计日志 |
| `GET` | `/api/v1/admin/reconcile` | 超级管理员 | D1 业务账本：`expected_used_bytes`、`used_delta_bytes` 和 `reservation_delta_bytes` |
| `GET` | `/api/v1/admin/reconcile/objects?bucket=private&limit=50&cursor=...` | 超级管理员 | 只读分页扫描 R2 物理对象，检查未登记或大小不一致；支持 `public` |

正常上传中的任务不会被管理员恢复接口主动中止。`recover` 返回 `RECOVERY_PENDING` 时不应该重新上传同一个大文件，等待后续任务继续检查。

## 4. 在已上线的 Cloudflare Worker 中升级

1. **确认部署目标是现有 `cloudflare-disk` Worker，D1 名称为 `clouddrive-db`，R2 桶为 `clouddrive-private`、`clouddrive-public`。** 不要新增资源，不要覆盖 `.dev.vars`、Secret 或真实 D1 数据库 UUID。
2. 如果 D1 存在重要数据，在 Cloudflare 中对生产 D1 执行备份/Time Travel 核实。**D1 备份不包含 R2 文件内容**；重要 R2 文件另行备份。
3. 应用补丁后运行 `npm run build`（语法检查 + 自动化测试，没有前端编译）。
4. `git add .`、`git commit`、`git push origin main`。Cloudflare Dashboard → Workers → `cloudflare-disk` → Settings → Builds 中保留 **Build Command=`npm run build`、Deploy Command=`npm run deploy`**。
5. RC5 自动部署脚本先对现有 D1 执行未应用的 `0012` SQL 迁移，再发布新版 Worker；如果迁移失败必须停止部署，不要用一个新数据库替代旧 DB。
6. 访问 `/api/v1/health/ready` 确认 `READY`，登录管理员 `/settings` 查看账本差异；R2 扫描仅分页读取，不会删除任何对象。

**重要：** 直接生产升级存在风险。API/单元测试是代码层自动检查，不能替代你的 Cloudflare Worker Free CPU、实际 R2、D1、浏览器下载行为验证。更新完成后建议先执行只读就绪检查，观察 Workers Logs 和 D1/R2 配额。

## 5. 容量核对字段解释

- `used_bytes`：D1 `spaces` 当前记账值。
- `expected_used_bytes`：数据库中“仍被逻辑文件引用的私有 R2 对象（按对象去重）+有效公开副本+待清理任务已收费物理对象”的估计合计。
- `used_delta_bytes`：账面值减上述估计值，非零提示需要人工调查；不能直接用数字覆盖 `spaces.used_bytes`。
- `upload_reserved_bytes`：上传会话仍持有的预留，含等待安全清理的已完成孤立对象。
- `reservation_delta_bytes`：空间预留减上传会话预留。小文件正在写入、公开资源发布中等场景会暂时产生正常差异。
- `/reconcile/objects`：每次只列出 1–100 个 **已完成** 的 R2 对象。未完成的 Multipart 分片、按月 GB-month 的计费量及 Workers 请求费用不包含在内。
- `untracked`：R2 物理对象没有对应 `storage_objects` 记录，可能是正在进行的事务或孤立对象。**不要直接删除**，核对时间、上传状态和 Cloudflare 日志后处理。

## 6. 预期限制

- 用户分片失败自动恢复依赖 `R2.head` / `R2MultipartUpload.complete` 的实际返回状态；网络不稳定时任务会保持预留，等待后续重试，不会假装成功。
- 回收站一次目录软删除最多 200 个活动项目。超出时返回 `TRASH_BATCH_LIMIT`，防止在免费 Worker 内不受限循环；未来若需要超大目录异步删除可增加 Durable Objects/队列方案。
- D1 和 R2 无跨服务原子事务。RC6 增加持久清理与补偿逻辑，但并未解决所有异常（如 D1 与 R2 同时不可用），此时需要依靠管理员只读诊断和备份。
- 物理公开 R2 自定义域名的 CDN 缓存无法保证撤销链接后立刻全球失效；严格有效期和即时拒绝新请求的资源应走 `/t/` 或 `/s/` Worker 鉴权。
- Workers Free 的 PBKDF2 计算成本需要在实际环境继续关注，RC6 不改现有密码哈希及登录密码 6–128 字符规则。
