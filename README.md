> **RC14.12 下载与部署热修复（2026-10-31）：** `wrangler.jsonc` 设置 `keep_vars: true`，自动部署脚本也会在生成的临时配置中启用 `keep_vars` 并追加 `--keep-vars`，以保留 Cloudflare 网页后台填写的普通 Text 环境变量（如 `MS_CLIENT_ID`）。现有 Microsoft Secrets 不需要更换。OneDrive `/r/odf_*` 下载增加显式 Graph 临时直链请求、旧接口兼容、无重定向时的 `/content` 流式回退和具体故障代码，并支持管理员“诊断下载”。R2、OneDrive 文件夹和公开合集支持双击行/卡片非操作区域打开，原“打开”按钮保留。**不需要新增 D1 迁移。** 详见 [部署及下载修复教程](docs/RC14_12_DOWNLOAD_DEPLOY_FIX.md)。

> **RC14.12 OneDrive 文件同步与运维：** 已公开 OneDrive 文件支持 Graph Delta 增量检测、eTag 条件查询、小批次健康检查、微软限流退避、授权状态诊断，以及后台“同步与运维”面板。同步只检查已发布来源，**不会自动公开文件、复制到 R2 或变更旧固定直链**。新增 `0031_rc14_12_onedrive_sync.sql` 迁移，适配有历史分享记录的数据库；默认沿用 6 小时 UTC Cron 和每批 8 文件。无新增强制 Secret。部署、设置项下方教程及注意事项见 [RC14.12 配置与运维说明](docs/RC14_12_ONEDRIVE_SYNC_OPERATIONS.md)。

> **RC14.11 OneDrive 分享权限与统计：** 已发布文件及文件夹/合集现在支持分享暂停与恢复、访问密码、指定到期时间、仅 CloudDrive 登录用户访问、浏览/下载跳转次数限制、权限继承与后台统计（最近 30 天）。修改权限后旧密码解锁 Cookie 立即失效；原有 `/s/odf_*`、`/r/odf_*` 和 `/s/odg_*` 不变。**需新增 D1 迁移** `0030_rc14_11_onedrive_share_controls.sql`，无强制新增 Secret。详见 [RC14.11 使用说明](docs/RC14_11_ONEDRIVE_SHARE_POLICY.md)。

# CloudDrive V1 — RC14.12

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/biao169/cloudflare_disk)

**Cloudflare 网页一键部署：** 点击上方 Deploy to Cloudflare，根据引导连接 GitHub、绑定 D1 和 R2；已部署网站应保留同名 Worker 和原有绑定，使用 `npm run build` / `npm run deploy` 更新。详细部署教程见本文第 0 节。

> **RC14.9 OneDrive 可视化分享页面：** 已发布的 OneDrive 文件现在同时拥有 **`/s/odf_*` 分享页面**和原有 **`/r/odf_*` 下载直链**。分享页可展示标题、介绍、文件大小、浏览器本地时区、封面与二维码；图片、PDF、常见视频格式支持按类型尝试在线预览。管理员在 `/onedrive` →「已发布直链」→「编辑展示」中修改信息、选择封面风格或上传自定义封面（2 MB 以内，保存在现有私有 R2）。需要新增一次 D1 迁移 `0028_rc14_9_onedrive_presentation.sql`；不需要新增 Microsoft Secret，也不要更改现有 `MS_TOKEN_KEY`。详见 [RC14.9 使用和升级教程](docs/RC14_9_ONEDRIVE_PRESENTATION.md)。

> **RC14.8 OneDrive 可视化文件管理：** 管理员登录后从左侧 **OneDrive 文件**（`/onedrive`）进入独立文件浏览器，支持网格/列表视图、全盘搜索、目录导航、Graph 签名分页（60 项/批）、缩略图、类型筛选、排序与跨目录多选；可以对单文件明确确认后发布固定直链，浏览与撤销已有链接。系统设置仍负责 OAuth 配置及逐项操作教程；原 `/tools/onedrive` 匿名工具、`/r/odf_*`、R2/用户/UTC 功能全部保留。**无需新增 D1 迁移或 Secret**。详见 [RC14.8 使用及升级说明](docs/RC14_8_ONEDRIVE_BROWSER.md)。

> **RC14.7 Microsoft OAuth 回调诊断修复：** 若之前出现 `OAUTH_CALLBACK_ERROR / OAUTH_FAILED`，新版会区分微软拒绝、账户类型、授权同意、回调 URI、Session 丢失及 Token 兑换错误。系统设置会显示**准确回调地址**，可选用 `MS_REDIRECT_URI` 固定自定义域名；无需变更 `MS_TOKEN_KEY` 或 D1。请看 [OAuth 回调排错和配置教程](docs/RC14_7_MICROSOFT_OAUTH_CALLBACK_FIX.md)。

> **RC14.7 Microsoft OneDrive 配置热修复：** `MICROSOFT_TOKEN_KEY_MISSING` 现在会明确区分“当前 Worker 运行时未收到 MS_TOKEN_KEY”和“密钥格式不正确”。系统设置 → 站点设置 → Microsoft OneDrive 账户新增三项运行时配置检查和详细教程；修复内容、密钥生成方式及生产/预览绑定排查请看 [Microsoft OAuth 配置排错](docs/RC14_7_MICROSOFT_CONFIG_FIX.md)。升级不需要额外 D1 迁移，原有 `MS_TOKEN_KEY` 不应更换。

> **RC14.1 历史说明（现已升级至 RC14.7）**：当时新增 `/tools/onedrive` 匿名分享链接格式解析工具。管理员在“系统设置”中可关闭工具或匿名访问。此版本**仅校验格式并生成 Graph 分享令牌**，不读取分享内容、不请求微软、不提供下载直链；真正的 Graph/OAuth 文件解析安排在后续阶段。

> **RC13.5 运维更新：** 旧 CDN 链接重试退避、历史版本安全保留及清理、版本同步与容量仪表盘。详见 [RC13.5 运维文档](docs/RC13_5_OPERATIONS.md)。生产部署仍使用 `npm run build` / `npm run deploy`。

## 历史版本功能及部署说明

> **RC13.4** 新增小型 UTF-8 文本在线编辑、Bootstrap 历史版本预览/下载/恢复、公开版本列表与同步管理。文件 ID、原有私密分享及 `/r/*` 永久链接保持不变。无需新增 D1 迁移或必需 Secret。详见 [RC13.4 使用与技术说明](docs/RC13_4_ONLINE_EDIT_AND_VERSIONS.md)。

> **RC13.3 已实现文件夹合并、镜像替换和持久化批量任务进度。** 在 `/files` 中点击“📁 合并/镜像更新文件夹”或拖拽本地文件夹，先查看服务器差异清单，再选择合并（保留旧项目）、镜像（上传成功后清理旧项目）或创建新文件夹。匹配文件的 ID、版本历史及私密分享链接继续保留，更新的永久 `/r/*` 按 RC13.2 自动指向新版。**新增迁移 `0021_rc13_3_folder_sync.sql`，不需要新 Secret，Build/Deploy 命令不变。** 详细说明：[RC13.3 文件夹更新与安全恢复](docs/RC13_3_FOLDER_SYNC.md)。

> **RC13.2 新功能：永久智能直链 `/r/{publicationId}`。** 覆盖现有文件时可在公开副本准备成功后自动切换最新版；新分享的 `url` 默认返回智能固定入口，原 `/p/*` 和已发出的 `published/*` CDN 地址继续兼容。详细说明见 [RC13.2 永久版本化与缓存规则](docs/RC13_2_PUBLIC_VERSIONS.md)。Cloudflare 网页端 Build Command 仍为 `npm run build`、Deploy Command 为 `npm run deploy`，无需新增强制 Secret。


> RC13.1 更新：同名文件上传可覆盖并保留私密分享链接，支持独立历史修订与恢复。详细说明见 [`docs/RC13_1_REPLACEMENT.md`](docs/RC13_1_REPLACEMENT.md)。永久公开 CDN 同步在 RC13.2 实现。



**源代码：** https://github.com/biao169/cloudflare_disk  
**当前已有 Worker：** `cloudflare-disk`  
**当前已部署站点：** https://cloudflare-disk.2948531734.workers.dev  
**架构：** 原生 HTML + Bootstrap 5 + JavaScript、Cloudflare Workers Free、D1、R2（公开/私有两个桶）。**无需 Vue、Vite 或前端编译。**

> RC5 已修复“Worker/R2/D1 Binding 均创建成功，但 `/api/v1/health/ready` 始终返回 `D1_MIGRATIONS_REQUIRED`”的问题。原因之一是 Wrangler 的自动资源创建允许省略 `database_id`，而远程 D1 migrations 命令可能要求真实 `database_id`。RC5 在部署过程中自动发现并注入 ID 到一个**临时**配置文件，不修改或提交账号专属 ID。另修复 `0001_initial.sql` 中不适合 D1 迁移事务的 `PRAGMA foreign_keys = ON`。

## RC12：日常文件操作体验（已包含）

RC12 在原有 RC11 安全权限基础上，新增 **跨空间全局搜索、拖拽文件/文件夹上传、常驻目录树、批量操作进度、个人收藏夹**。搜索和收藏始终复用当前登录权限；文件内容仍保存在原 R2，不迁移文件。拖拽文件夹在 Chrome/Edge 支持，最多每批 500 个文件、12 层目录；批量移动/复制/删除增加可见进度与失败明细。顶部菜单新增 `/search` 与 `/favorites`。

- **生产更新**：保持 Cloudflare Build Command `npm run build`、Deploy Command `npm run deploy`，GitHub 生产分支 `main`，`cloudflare-disk` Worker 和现有 D1/R2/Secrets 均保持不变。
- **D1 增量迁移**：`0018_rc12_file_experience.sql`，仅新增 `favorites` 表和索引，不删除历史用户、文件或分享记录。
- **无需新增环境变量/Secret**。`SHARE_LINK_KEY` 原值不要更换。
- **详细说明**：参见 [RC12 文件操作体验说明](docs/RC12_FILE_EXPERIENCE.md)。

## RC11：安全边界、权限批量查询与免费版稳定性修复（既有稳定性修复）

本版本在 RC10 原有链接找回与属性编辑功能上，新增 **D1 批量 ACL 查询**、分享记录批量状态计算、目录移动权限确认、回收站 SQL 参数安全拆批、限次分享耗尽后的预览阻断、按 IP 聚合登录失败限制，以及自动清理过期会话/密码授权等功能。**不修改已存文件、管理员密码、已有分享令牌、R2 对象或 Secret。**

- Cloudflare Dashboard 保持 **Build Command `npm run build`、Deploy Command `npm run deploy`**。Build 新增迁移安全静态检查；远程增量迁移 `0017_rc11_security_performance.sql` 只增加索引。
- 将文件夹移动至其他父目录可能扩大继承访问权限。**只有空间管理员可以移动**，并且必须明确确认；普通编辑者仍可重命名其有写权限的目录。
- **限次分享**：未达到限额前，合法预览不扣下载次数；额度耗尽后，新的预览、下载与目录访问全部被拒绝。无法撤回已下载或通过预览保存的内容。
- 自动清理：每日现有 Cron 维护中加入过期 `sessions`、`share_access`、失败登录和分享密码尝试记录的安全分批清理，不删除尚未到期的会话。
- 本版本没有新增或更换 Worker Secret；尤其不要更换已有的 `SHARE_LINK_KEY`。API、兼容性和限制见 [RC11 安全与性能变更](docs/RC11_SECURITY_PERFORMANCE.md)。

**升级生产环境前先备份 D1 和重要 R2 对象**。新加的 SQL 静态检查不等同于数据库备份，也不保证跨服务的自动回滚。

## RC10：再次分享直接显示原链接并编辑属性（推荐优先阅读）

从文件列表或最近文件点击 **「分享 / 管理」**：先显示该文件由当前账号创建的已有分享；加密保存的原 URL 会自动读取最新一条并提供复制按钮。可以直接修改有效期、下载次数、页面下载开关、访问密码，**修改不会生成新链接**。已过期链接可以延长后继续使用原地址；永久公开 R2 的 URL 也在同一窗口管理。

为确保以后能够找回新建的原始链接，建议事先在 Worker **运行时 Secret** 中配置并长期保留 `SHARE_LINK_KEY`（32 字节随机值，64 个十六进制字符）。**旧版只保存 SHA-256 摘要的链接无法恢复原令牌**：仅可主动轮换为新链接，旧地址立即失效。`0016_rc10_existing_links.sql` 只新增可空字段，保留原用户/文件/分享。Build Command `npm run build`、Deploy Command `npm run deploy` **不变**。详见 [RC10 改动与安全使用说明](docs/RC10_EXISTING_SHARE_LINKS.md)。

## RC9：生产运维仪表盘、容量预警、自动清理和完整备份恢复

**保持 Cloudflare 免费架构和原有 Worker/D1/R2 不变。** RC9 新增 `0015_rc9_operations.sql`（只增表和索引）、持久化运行记录和异常事件、全局/空间配额预警、统一运维管理页面 `/settings`、带 D1 任务锁的 Cron 小批次清理，以及 Windows D1 SQL + 私有/公开双桶真正文件备份脚本。恢复默认只读预检查，真实恢复只允许新建隔离资源。

已有 Cloudflare **Build Command `npm run build`、Deploy Command `npm run deploy` 不变**。新增 SQL 在部署时自动应用。Cron 改为 UTC 每 6 小时运行：`0 */6 * * *`，不产生新的 Cron Trigger 数量要求。**不用新增 Worker Secret**；`BOOTSTRAP_TOKEN`、`SHARE_LINK_KEY` 不要改变。

**完整备份（Windows，需配置 rclone 的 R2 remote）**：`powershell -ExecutionPolicy Bypass -File .\scripts\backup-production.ps1 -R2Remote r2`。R2 内容不能靠 D1 的免费 7 天 Time Travel 恢复。运维细节、隔离恢复步骤、状态码和安全边界：[docs/RC9_OPERATIONS.md](docs/RC9_OPERATIONS.md)。

## RC8：统一分享、权限编辑、链接安全恢复与公开 CDN

本次基于 RC7，统一文件行和「我的分享」的 Bootstrap 分享管理弹窗：查看全部已有链接，设置/修改有效期、下载上限、页面下载开关、访问密码，显示过期/撤销/源文件已删除/创建者权限失效等状态。新增 `0014_rc8_share_management.sql` **仅新增加密密文字段和索引，不删除旧分享**。

**重新获取链接需要额外设置（建议）**：在现有 Worker → **Settings → Variables and Secrets → Add Secret** 添加稳定的 `SHARE_LINK_KEY`（32 字节，即 64 位十六进制字符）；不配置时仍可使用分享功能，但原链接只在创建时显示，之后只能轮换生成新链接。**旧版本分享令牌此前仅存哈希，无法恢复；轮换会使旧链接失效。不要在生产运行后随意更换 `SHARE_LINK_KEY`。**

**公开 CDN**：仅对 R2 `clouddrive-public` 绑定**自定义 HTTPS 子域名**，然后在 GitHub 仓库 `wrangler.jsonc → vars.PUBLIC_BASE_URL` 中填写 `https://cdn.example.com`（替换为实际域名）。`clouddrive-private` 永远保持私有。撤销 CDN 发布后缓存可能继续存在，建议可选配置 `CDN_ZONE_ID` 和 `CDN_PURGE_TOKEN` 以尝试单 URL 缓存清理。**不设置域名则仅为 Worker `/p/` 公开直链，不是 CDN 直连。**

现有 Dashboard 配置继续保持 **Build Command `npm run build`，Deploy Command `npm run deploy`**。升级说明与 API： [docs/RC8_SHARE_MANAGEMENT.md](docs/RC8_SHARE_MANAGEMENT.md)。

## RC7：生产版文件浏览、最近文件与就地分享

RC7 在 RC6 的可靠性修复基础上，新增真实的跨授权空间“最近文件”、文件管理列表/网格切换、排序、类型筛选与分页、可浏览的目标目录选择器、文件及目录批量移动/删除、批量复制文件，以及文件行和文件夹行直接打开的 Bootstrap 分享弹窗。**分享弹窗提供模式和时效设置，不跳转到独立的分享创建页面，也不要求用户输入 UUID。** 原生浏览器下载继续避免大文件被完整加载到 JavaScript 内存，并加入 `If-Range` 对象版本检查。

新增 SQL 迁移 `0013_rc7_file_browser.sql` 仅添加两个非破坏性索引；无需重新初始化管理员或重新创建 D1/R2。**现有网页部署命令保持 `npm run build` / `npm run deploy` 不变**，自动执行待应用的迁移。参见 [RC7 详细功能、API、升级与限制](docs/RC7_FILE_EXPERIENCE.md)。

## RC6：此次生产升级先看这里

在 RC5 自动部署基础上，RC6 修复了团队权限变化后的旧分享访问、回收站访问控制与独立子项恢复、分片合并失败后的 R2/D1 恢复、浏览器大文件 Blob 内存占用以及存储容量核对。**新增一份增量 D1 迁移** `0012_rc6_reliability.sql`，其余已迁移 SQL 不变。

**保持现有 Cloudflare Builds 设置**：`Build Command = npm run build`、`Deploy Command = npm run deploy`。更新 GitHub main 后自动先迁移生产 D1、再更新同名 Worker；不要创建新桶、重新初始化管理员或删除既有数据库。变更细节、数据安全边界与新的恢复/核对接口见 [RC6 生产安全修复说明](docs/RC6_PRODUCTION_HARDENING.md)。

管理员登录 `/settings` 可以查看只读 D1 账本差异、分页扫描公开/私有 R2 对象，并有权限触发 **每批最多 3 个任务** 的停滞上传恢复。物理扫描仅核对，不会自动删除未跟踪对象或强行重算配额。**升级生产前请备份重要 D1 及 R2 数据。**

## 0. 已有 Cloudflare Worker：只需设置一次构建/部署命令

1. 将本版全部改动推送到已有 GitHub 仓库的 `main` 分支（不要创建第二个 Worker，也不要删除现有 D1、R2 桶）。确认 `wrangler.jsonc` 中 `name` 是 **`cloudflare-disk`**；否则可能部署出一个不同名称的 Worker。
2. 进入 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → 选择当前的 **cloudflare-disk** → **Settings → Builds**。
3. 检查 **Git Repository**=`biao169/cloudflare_disk`、**Production Branch**=`main`、**Root Directory**=`/`（仓库根目录）。
4. **Build Command** 填写 `npm run build`：它只执行语法/单元/API 集成测试，**不编译前端**。
5. **Deploy Command** 填写 **`npm run deploy`**：自动识别 D1、执行尚未应用的 SQL 迁移、验证表结构，然后部署 Worker。**不要填写** `npx wrangler deploy`，否则会跳过迁移。
6. 保存 Build 设置后，重新运行/触发该分支的部署（新 Git commit 推送也会触发）。如果之前的 Cloudflare 部署任务在修改命令前就已排队，请确认新任务日志包含 `[CloudDrive]` 迁移记录。
7. 等待部署日志包含 `远程 D1 表结构已验证` 和 `Worker 代码已发布`，才算完整成功。静态资源或桶成功创建，不代表数据库已经初始化。
8. 访问 [数据库就绪检查](https://cloudflare-disk.2948531734.workers.dev/api/v1/health/ready)；不应再出现 `D1_MIGRATIONS_REQUIRED`。

**无需预先填写 D1 database_id。** 当前部署脚本会运行 `wrangler d1 list --json`，按 `database_name: clouddrive-db` 查找真正的 UUID，创建临时配置（不会上传 GitHub），再执行 `wrangler d1 migrations apply DB --remote`。如果查询权限/网络失败，脚本**中止且绝不把失败当作“数据库不存在”**，防止误建新的 D1。首次新部署则先由 Cloudflare 自动创建绑定资源，再查询真实 ID、迁移、验证并完成发布。

### 0.1 部署前和初始化前需要准备的变量

| 配置 | 位置 | 要求 | 用途 |
|---|---|---|---|
| `BOOTSTRAP_TOKEN` | **Worker Settings → Variables and Secrets → Secret** | **首次创建管理员必需**；随机 32 字符以上，建议 64 位十六进制字符 | 管理员首次初始化验证。绝不写进 Git 或 Build 日志 |
| `APP_NAME` | `wrangler.jsonc → vars` | 已有默认 `CloudDrive` | 网盘名称 |
| `APP_STAGE` | `wrangler.jsonc → vars` | 已有默认 `rc13.3-folder-sync` | 版本诊断 |
| `PUBLIC_BASE_URL` | `wrangler.jsonc → vars` | 默认空，可暂不填写 | **真实公开桶自定义 HTTPS 域名**；留空使用 Worker `/p/{id}` |
| `SHARE_LINK_KEY` | Worker Runtime Secret | 建议设置稳定的 64 位十六进制字符 | 允许新/轮换后分享链接安全重新获取；旧哈希链接必须轮换 |
| `CDN_ZONE_ID` / `CDN_PURGE_TOKEN` | Worker Runtime Secret（可选） | CDN 域名所属 Zone 和 Cache Purge API Token | 撤销公开直链时尝试清理 CDN 缓存 |
| `DB` | `wrangler.jsonc → d1_databases` | 自动绑定 `clouddrive-db` | D1 数据库（不能作为普通环境变量填写） |
| `PRIVATE_BUCKET` | `r2_buckets` | `clouddrive-private` | 真实文件，**绝不启用 R2 公开域名** |
| `PUBLIC_BUCKET` | `r2_buckets` | `clouddrive-public` | 主动公开发布的文件 |
| `ASSETS` | Workers Static Assets | 自动提供 | HTML/CSS/JS 页面 |

> **Build Variables 和 Worker Runtime Secrets 不一样。** `BOOTSTRAP_TOKEN` 应设置在运行时 `Variables and Secrets`，不是仅保存在 Build Settings 中。部署时生成 Secret 不应写入 `package.json` 或 `wrangler.jsonc`。

### 0.2 部署好之后先访问什么？

1. **诊断：** https://cloudflare-disk.2948531734.workers.dev/api/v1/health/ready
2. 返回 `BOOTSTRAP_SECRET_REQUIRED`：在 Worker 运行时 Secrets 中添加 `BOOTSTRAP_TOKEN`；保存并部署使 Secret 生效。
3. 返回 `ADMIN_SETUP_REQUIRED`：打开 https://cloudflare-disk.2948531734.workers.dev/setup （或 `/login`），输入管理员用户名、**6–128 个 Unicode 字符**登录密码及 `BOOTSTRAP_TOKEN` 创建首个超级管理员。
4. 创建成功后再登录，访问 https://cloudflare-disk.2948531734.workers.dev/files ，测试上传、权限、预览、分享、恢复。
5. 返回 `READY`：说明基础 D1 表和管理员已准备好（不代表所有功能均已完成真实浏览器验收）。

| 就绪代码 | 含义和操作 |
|---|---|
| `D1_MIGRATIONS_REQUIRED` | 远程 D1 未完成迁移；确认最新部署日志包含 D1 migrations，尤其要核查执行配置和迁移失败信息 |
| `BINDING_MISSING` | DB/R2/ASSETS Binding 缺失；检查 Worker Settings → Bindings |
| `D1_QUERY_FAILED` | D1 查询失败；查看 Worker Logs |
| `BOOTSTRAP_SECRET_REQUIRED` | 迁移成功但未设首次安装 Secret |
| `ADMIN_SETUP_REQUIRED` | 数据库准备好，可以访问 `/setup` 初始化 |
| `READY` | 数据库表/初始管理员就绪，可登录 |

**未初始化时应该有网页：** `/setup`、`/login` 始终由静态 `login.html` 提供，并显示明确的迁移/初始化状态。`assets.html_handling = "none"` 防止 `/login.html` 与 `/login` 无限 307 重定向。

## 1. 一键部署到新的 Cloudflare 免费账户

1. 打开顶部 **Deploy to Cloudflare** 按钮，连接公开 Git 仓库，选择 Free 计划，并按网页提示允许自动创建 D1/R2。R2 启用可能要求添加支付方式；免费存储额度不等于超额绝对不收费。
2. Worker 名称默认为代码的 `cloudflare-disk`，可以在首次部署前修改 `wrangler.jsonc` 以避免与已有名字冲突。
3. Build Command 使用 `npm run build`；Deploy Command 使用 **`npm run deploy`**。首次会经过“自动创建 D1/R2 → 查询数据库 ID → 迁移 → 验证 → 发布”流程。
4. 创建完成后到 Worker **Settings → Variables and Secrets** 添加 `BOOTSTRAP_TOKEN` Secret。
5. 依照上一节的就绪检查和 `/setup` 页面初始化超级管理员。

配置文件已预留自动资源创建，**不应把 `database_id`、Cloudflare Token 或管理员密码提交到 GitHub**。

## 2. 后续更新（无需每次填写变量或重建数据库）

- **修改代码、推送 `main`** → Cloudflare 自动运行 Build `npm run build` → Deploy `npm run deploy`。
- 部署脚本首先按名字寻找**已存在的** D1；找到后临时绑定真实 UUID，然后应用**尚未运行**的 SQL 迁移，检查必需表存在，最后发布新版 Worker。
- 默认不会删除 D1 或 R2，不会再次创建同名数据库；若远程 D1 列表查询出错、ID 不匹配或迁移失败，停止部署并报告错误，避免静默覆盖数据。
- D1 迁移命令由 Cloudflare 自动创建迁移备份（详见官方文档）；重要数据升级前仍建议额外备份并记录回滚方案。**已应用迁移不能随意改写；新结构调整应新增编号 SQL 文件。**
- 若你只需要迁移现有 D1，使用 `npm run db:migrate:remote`；只查待迁移文件，用 `npm run db:migrations:list:remote`；导出远程 D1 到本地 `backups/` 用 `npm run db:backup:remote`。这些命令均自动解析 ID。
- Cloudflare Dashboard 的构建/部署设置是**账户上的独立配置**；代码不能替你无条件修改已有 Worker 的 Dashboard 选项。所以只需要第一次手动把 Deploy Command 改为 `npm run deploy`，之后 GitHub 更新即可自动执行。

## 3. Windows 本地开发（无需前端编译）

```powershell
cd D:\Python\b01-website\web-all\CloudDrive
npm install
Copy-Item .dev.vars.example .dev.vars
# 编辑 .dev.vars 中的 BOOTSTRAP_TOKEN，且不要提交该文件
npm run db:migrate:local
npm run dev
```

打开 http://localhost:8787/setup 或 http://localhost:8787/login。Wrangler 本地 D1/R2 状态位于 `.wrangler/`，与生产分离。常用命令：

```powershell
npm run build           # 只运行全部自动化测试，没有前端编译
npm run deploy          # 生产自动迁移并部署（需要 Cloudflare 认证）
npm run deploy:upgrade  # 只允许升级现有数据库；不存在时停止
npm run db:migrate:remote
npm run db:backup:remote
```

`node_modules/`、`.wrangler/`、`.dev.vars`、构建时临时生成的 `.clouddrive-deploy-*.jsonc` 均应保持在 `.gitignore` 中。

## 4. 项目功能与技术架构

- 多人账号体系、角色权限、个人/团队空间及文件夹级 ACL。
- 文件夹和文件的 D1 元数据管理、目录选择、批量操作、真正的最近文件、列表/网格浏览、重命名、搜索。
- 私有 R2 普通/Multipart 上传、断点续传、权限保护的下载和 Range 支持。
- 图片、MP4/WebM、PDF 在线预览。
- 公开发布直链、临时直链、密码分享页面、文件夹分享；每个文件/文件夹行就地弹窗配置模式和有效期。
- 回收站、自动过期清理、存储清理重试、应用级容量软上限。
- 原生静态 HTML/CSS/JS + Bootstrap，Wrangler 自动处理 Worker 发布，没有 Vue/Vite 构建系统。

项目目录：`public/` 前端、`worker/` 后端、`migrations/` SQL、`scripts/` CLI/Windows、`tests/` 自动测试、`docs/` 技术文档。详细参见 [自动部署架构与排查](docs/RC5_AUTO_DEPLOY.md)、[API](docs/API.md)、[数据库](docs/DATABASE.md)、[安全](docs/SECURITY.md)。

## 5. 安全与免费额度注意事项

- **R2 Standard 免费 10 GB-month 是账户级存储计费额度，不是每桶各 10 GB。** 默认 8 GiB 应用软上限不能绝对防止额外操作费、孤立文件等。
- Worker Free 常见单请求 CPU 上限 10 ms。登录/分享密码 PBKDF2 100,000 次迭代仍需在真实 Workers Free 中验证，**本地测试通过不代表线上运行一定符合 CPU 限制**。
- 管理员登录密码长度 6–128 个 Unicode 字符；分享访问密码有独立规则。密码哈希为 PBKDF2-SHA256，256 位派生输出，盐 128 位。此处的 128 位不是平台要求哈希只能 128 位。
- 私有 R2 不开启公开访问；不要将生产 Token、初始化 Secret、D1 备份或 `.dev.vars` 上传 GitHub。
- **本仓库为 RC 发布候选版**：本次提供本地模拟部署测试与 SQLite 测试，并未实际访问你的 Cloudflare 账户执行远程迁移或线上网页验收。请确认迁移日志、就绪接口和真实文件上传/分享流程后再正式使用。

## 6. Cloudflare 官方参考

- [Workers Git 自动构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
- [Deploy to Cloudflare / 自动资源创建](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Wrangler D1 Migration](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 foreign key 规则](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)
- [Wrangler 自动创建资源](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)
- [自动绑定与 D1 子命令兼容性问题](https://github.com/cloudflare/workers-sdk/issues/13632)


## RC14.10 — OneDrive 文件夹、合集与批量发布

在 **OneDrive 文件** (`/onedrive`) 中选择文件或文件夹，点击“创建分享 / 批量发布”，按三步确认创建。

- 单文件夹静态快照或跨目录文件合集使用 `/s/odg_*` 公开浏览；内含文件沿用 `/s/odf_*` 预览页与 `/r/odf_*` 下载入口。
- 最多 180 个目录项、8 层目录及 20 页 Graph 列表；批量独立发布最多 25 个文件。
- **不会自动公开以后加入 OneDrive 文件夹的新文件。** 所有创建操作由超级管理员明确确认。
- 后台可编辑合集标题和描述，撤销合集会停用该组专属的全部文件直链。
- 升级需执行 D1 迁移 `0029_rc14_10_onedrive_groups.sql`，无需新增 Secret。

详细部署和使用说明见 `docs/RC14_10_FOLDER_COLLECTION_BATCH.md`。
