# CloudDrive RC14.12 — OneDrive 文件同步、性能与运维教程

> 适用基线：RC14.11；只需要增量升级现有 Worker/D1/R2，不要重新创建账号、数据库、桶或替换加密 Secret。

## 一、功能与安全边界

本版本仅同步**管理员明确公开发布**的 OneDrive 文件的来源元数据：来源文件 ID、名称、大小、MIME 类型、eTag、最近修改时间及健康状态。不复制文件字节到 R2、不自动公开新增 OneDrive 文件、不变更现有 CloudDrive 固定分享 ID、不自动撤销或重新启用分享。

- Graph Delta：默认启用。首次使用 `?token=latest` 建立后续变化游标，不枚举整个 OneDrive；每次维护至多读取**一页**变更，游标保存在仅服务端访问的 D1 表 `onedrive_sync_drives`。
- 已发布文件健康检查：默认每次维护检查**最多 8 个文件**，间隔默认 **6 小时**。检查采用 `If-None-Match`，Microsoft 返回 HTTP 304 时不重复读取完整元数据。变更后保留 `odf_*` 文件 ID，更新展示用元信息。
- 异常分类：`healthy` 正常、`changed` 待核实修改、`missing` 来源不存在、`denied` 访问被拒、`reauthorize` 需重新授权、`throttled` 微软限流、`error` 其他检查失败；旧数据初始化为 `unknown`。出现 429/503 时使用微软 `Retry-After` 或指数退避，并停止本批次继续向微软请求；无无限重试或后台高频轮询。
- 日志：D1 的 `onedrive_sync_events` 只保存分享 ID、状态代码和 UTC 时间，定期分批删除 90 天前的事件；不记录 Graph Token、URL、文件名、Cookies、文件内容或微软临时下载地址。
- 下载：优先复用有效预授权下载 URL 的即时 302 分发。当 Graph 不返回这种 URL 时，尝试对经 CloudDrive 权限验证的用户从 Graph `/content` 获取数据，使用 Worker 流式响应（不构建内存 Blob）；支持有限格式的 Range，保留密码、过期、下载次数等现有检查。某些 Microsoft 365 租户可能需要新的令牌受众或 `/contentStream` 兼容适配，**并非保证所有微软账号已支持**。

## 二、管理员界面及逐项配置

入口：管理员登录 → **OneDrive 文件** (`/onedrive`) → **同步与运维**。可以查看健康状态聚合、Delta 初始化状态、最近事件，执行以下操作：

- “刷新同步状态”：只查询 D1 已记录的结果，**不代表实时请求微软**。
- “检查 Microsoft 授权”：即时检查当前绑定账号是否能通过 Graph `/me/drive` 访问 OneDrive，不返回身份资料或 Token。
- “立即运行一次同步”：共用现有维护租约，同步进行有界检查；如果定时任务正在执行则显示“正在运行”。
- 已发布直链列表中的“检查来源”：仅检查这一条分享的源文件，状态变化不会撤销分享。

入口：**系统设置 → OneDrive 文件同步与健康检查**，每项下方均有简明教程：

| 配置项 | 默认 | 含义 |
| --- | --- | --- |
| `onedrive_sync_enabled` | `true` | 同步总开关。关闭后 Cron 不检测来源；**不影响旧下载链接** |
| `onedrive_delta_enabled` | `true` | 开启 Delta；若账号接口不支持可关闭，仍使用逐文件检查 |
| `onedrive_sync_interval_hours` | `6` | 同一文件检查最小间隔，整数 1–168 小时 |
| `onedrive_sync_batch_limit` | `8` | 每次 Cron 检查最多多少已发布文件，整数 1–20 |

原有 `wrangler.jsonc` Cron 触发器仍为 `0 */6 * * *`，即每 **6 小时 UTC** 运行。配置的“最低检查间隔”不会改变 Cron 频率，例如改为 1 小时也不会自动每小时运行。任务开启状态还受到原有 `maintenance_paused` 总开关约束。调小时间间隔可能增加 Graph/D1 请求及 Microsoft 429 风险。

`MS_CLIENT_ID`、`MS_CLIENT_SECRET`、`MS_TOKEN_KEY`、`MS_TENANT` 等保持现值；**不要求新 Secret，不应重新授权**。系统设置的 Microsoft OAuth 配置教程继续可用。

## 三、新增管理员 API

仅超级管理员会话能够调用，非管理员和匿名用户均不能读取：

| 方法与地址 | 用途 |
| --- | --- |
| `GET /api/v1/admin/onedrive/sync/status` | D1 健康状态、近期事件（不含 Graph 游标/Token） |
| `POST /api/v1/admin/onedrive/sync/auth-check` | 检测 Graph 账号授权有效性 |
| `POST /api/v1/admin/onedrive/sync/run` | 立即执行有界同步（使用维护租约） |
| `POST /api/v1/admin/onedrive/sync/items/odf_.../check` | 仅检查指定已发布文件 |

系统设置继续使用既有 `GET/PATCH /api/v1/admin/settings`。所有 API 需要有效 CloudDrive 管理员会话以及站点已有的 CSRF/Origin 检查。

## 四、数据库与部署

新增迁移：`migrations/0031_rc14_12_onedrive_sync.sql`。

- 对现有 `onedrive_drive_publications` **仅增加**健康状态与调度字段，不更改旧文件 ID、分享令牌、权限策略、下载/浏览计数或 OAuth 密文。
- `next_check_at` 使用一个固定的 UTC 历史哨兵值表示“尚未检查，等待首次 Cron”，保证能够安全迁移**已经有分享记录**的 D1 表。首次检查后改写为真实 UTC 计划时间。
- 新增 `onedrive_sync_drives`、`onedrive_sync_events` 与必要索引，无数据删除语句。
- 所有时间以 UTC 保存，前端继续使用现有时区工具显示浏览器当地时间。

**Cloudflare Worker 已有部署的升级顺序：**

1. 先备份生产 D1（建议同时备份关键 R2 文件），记录旧版 Worker 版本。不要删除或重建 D1、R2、Microsoft Secrets。
2. 在 RC14.11 基线覆盖 RC14.12 增量补丁，或者使用 RC14.12 完整源码；留意保留当前项目中的 `wrangler.jsonc` 专有数据库、桶名和域名配置。
3. 在项目根目录运行 `npm run build`。成功后运行 `npm run db:migrate:remote` 应用 `0031`。
4. 运行 `npm run deploy` 部署原来的 Worker。项目部署脚本可能重复**检查**迁移状态；不要手动反复执行 SQL 文本或跳过迁移。
5. 以超级管理员进入 `/onedrive` → 同步与运维 → 检查授权 → 运行一次同步。检查 `status_counts` 和最近事件、维护记录，然后验证原 `/r/odf_*` 与 `/s/odg_*` 仍可访问。
6. 对同一个真实、可公开分享的测试文件依次进行改名、修改、访问撤销测试；旧固定 ID 应不变，状态需在后续检查中更新。

如在 Cloudflare Pages 中使用 GitHub 自动部署，维持现有 Build `npm run build` 和 Deploy `npm run deploy`。不能把 `.dev.vars`、`.env` 或真正的微软密钥提交 Git 仓库。

## 五、常见问题与诊断

| 现象 | 处理方式 |
| --- | --- |
| `reauthorize` / Graph 401 | Microsoft OAuth 令牌失效。系统设置重新连接账号，检查回调地址与对应 Microsoft App 注册 |
| Graph 403 | 管理员缺乏文件权限、文件跨账号/组织、租户共享策略拒绝；不要用游客身份绕过权限 |
| Graph 404 / `missing` | 文件被删除或来源 ID 不可访问；不会自动删除 CloudDrive 分享记录 |
| Graph 429/503 / `throttled` | 遵守 `Retry-After`、等待下次定时任务，必要时调低单批数量 |
| Delta 410 | 旧游标过期，自动重置为 `token=latest`；单文件检查仍会核实已有公开项 |
| 刚创建链接却未显示健康 | 初始状态 `unknown` 正常；下一次任务或手动检查后更新 |
| 同步成功但下载仍失败 | 健康检查仅验证**源文件元信息**，不代表微软服务器、网络或下载路径当前完全可用；请用测试下载独立检查 |
| 手动运行显示 `skipped` | 现有 Cron/管理任务持有维护租约，或全局维护已暂停；稍后检查维护运行记录 |
| 一批后仍有待检查文件 | 每次处理数量受限（默认 8），是为降低 Worker Free/D1/Graph 压力而设计 |

## 六、2027 年 Microsoft 下载兼容性预警

Microsoft 365 开发者公告：**自 2027 年 4 月 1 日起**，OneDrive 和 SharePoint Online 将逐步移除部分通过 URL 自带认证信息的临时下载 URL，相关 Graph 接口可能改为直接返回文件流，或要求对应受众的 Entra 访问令牌。本版本已提供 Graph `/content` 流式回退以覆盖一部分场景，但未在开启新租户策略的真实 Microsoft 365 租户中端到端验证，**不能据此宣称完全兼容未来所有组织**。后续如微软要求 SharePoint 专用资源受众 Token、`/contentStream` 或组织应用权限，应按官方 API 调整并在测试租户验证。

参考：
- https://learn.microsoft.com/en-us/graph/api/driveitem-delta
- https://learn.microsoft.com/en-us/graph/throttling
- https://devblogs.microsoft.com/microsoft365dev/pre-authenticated-tempauth-urls-are-retiring-move-to-microsoft-entra-id-tokens-before-april-1-2027/

## 七、回归验证范围和限制

本版本针对 SQLite/D1 模拟环境测试迁移、已有分享记录的升级、Delta 续页和重置、文件内容变化、429 退避、过期授权、权限状态、Graph `/content` 流式下载、共享链接计数及恶意内容类型拦截。现有 R2、普通文件分享、密码权限、CloudDrive UTC 时区展示必须继续测试。

**尚未完成：** 真实 Microsoft 账号与 Cloudflare 生产环境的端到端验证、Web 浏览器 UI 截图验收、生产并发压测、组织租户新预授权 URL 策略测试。发布前请使用测试资源逐项验收。
