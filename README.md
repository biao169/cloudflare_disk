# CloudDrive V1 RC5 — Cloudflare 网页版自动部署（优先阅读）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/biao169/cloudflare_disk)

**源代码：** https://github.com/biao169/cloudflare_disk  
**当前已有 Worker：** `cloudflare-disk`  
**当前已部署站点：** https://cloudflare-disk.2948531734.workers.dev  
**架构：** 原生 HTML + Bootstrap 5 + JavaScript、Cloudflare Workers Free、D1、R2（公开/私有两个桶）。**无需 Vue、Vite 或前端编译。**

> 本版专门修复“Worker/R2/D1 Binding 均创建成功，但 `/api/v1/health/ready` 始终返回 `D1_MIGRATIONS_REQUIRED`”的问题。原因之一是 Wrangler 的自动资源创建允许省略 `database_id`，而远程 D1 migrations 命令可能要求真实 `database_id`。RC5 在部署过程中自动发现并注入 ID 到一个**临时**配置文件，不修改或提交账号专属 ID。另修复 `0001_initial.sql` 中不适合 D1 迁移事务的 `PRAGMA foreign_keys = ON`。

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
| `APP_STAGE` | `wrangler.jsonc → vars` | 已有默认 `rc5-auto-deploy` | 版本诊断 |
| `PUBLIC_BASE_URL` | `wrangler.jsonc → vars` | 默认空，可暂不填写 | 配置 R2 CDN 自定义域名；留空使用 Worker `/p/{id}` |
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
- 文件夹和文件的 D1 元数据管理、批量移动、重命名、搜索。
- 私有 R2 普通/Multipart 上传、断点续传、权限保护的下载和 Range 支持。
- 图片、MP4/WebM、PDF 在线预览。
- 公开发布直链、临时直链、密码分享页面、文件夹分享。
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
