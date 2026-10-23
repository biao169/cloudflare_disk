# CloudDrive — Cloudflare 网页端一键部署（优先阅读）

> 本项目没有 Vue/Vite 编译过程。Cloudflare 官方 **Deploy to Cloudflare** 支持从公开 GitHub/GitLab 仓库自动创建 Worker、D1 和 R2 Binding，并执行本项目的 D1 迁移。**仍需你首次填写安全的管理员初始化密钥，且需实际测量 Workers Free 10ms CPU 限额。** 此次已准备可部署的源码和配置，但尚未代表你创建 GitHub 仓库或部署到 Cloudflare。

## 0.1 纯网页部署：准备仓库 → 点击部署

1. 解压本 ZIP，进入 `CloudDrive/`。在 [GitHub 创建公开仓库](https://github.com/new)（例如 `CloudDrive`），通过网页的 **Add file → Upload files** 上传 **`CloudDrive/` 文件夹里面的全部文件到仓库根目录**，而不是上传 ZIP。仓库根目录应直接包含 `package.json`、`wrangler.jsonc`、`worker/`、`public/`、`migrations/`。不要上传 `.dev.vars`、`.env`、`.wrangler/` 和真实账号密码。GitHub 网页上传可能存在单次文件数量限制，可分批上传；隐藏文件（如 `.dev.vars.example`）和 `.github/` 目录也应核对是否在仓库中。
2. 在 Windows 上双击解压后 `CloudDrive/` 下的 **`deploy-link.html`**，粘贴刚建立的 **公开** GitHub/GitLab 仓库网址，点击“打开 Cloudflare 一键部署页面”。页面下方还可以生成安全的 `BOOTSTRAP_TOKEN`（256 位随机密钥），用于后续初始化管理员；整个过程不需要安装 Node.js。
3. 也可直接把真实仓库 URL 替换到以下官方部署链接中的占位符后，在浏览器打开：

   ```text
   https://deploy.workers.cloudflare.com/?url=https://github.com/你的用户名/你的公开仓库名
   ```

   仓库发布后，可将仓库 `README.md` 顶部换成你的真实地址并启用以下按钮格式：

   ```markdown
   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/你的用户名/你的公开仓库名)
   ```

4. 在官方部署页面登录 Cloudflare 和 GitHub，选择免费 Workers 计划（R2 是否能启用以及付款方式以 Cloudflare 控制台为准），检查 Worker 名、D1 数据库和两个 R2 桶。**Cloudflare 会根据仓库 `wrangler.jsonc` 自动配置这些资源和 Bindings**。本仓库 `package.json` 的 `deploy` 脚本会先按 `DB` Binding 执行 D1 的全部未应用 SQL 迁移，再部署 Worker。**不需要前端构建命令，Build Command 留空**；Deploy Command 选择/保持 `npm run deploy`。
5. 如部署向导出现 `BOOTSTRAP_TOKEN`，将它填写为**自行生成的至少 32 个随机字符**，不要使用 `.dev.vars.example` 的占位值。若向导未要求，部署后访问 **Cloudflare Dashboard → Workers & Pages → clouddrive → Settings → Variables and Secrets → Add → Secret**，名称填 `BOOTSTRAP_TOKEN`，值填强随机字符串，并保存/部署新版本。不要把这个值写进 `wrangler.jsonc` 或公开仓库。
6. 打开控制台展示的 `https://<worker>.<subdomain>.workers.dev/login`，首次按提示使用上述初始化密钥创建超级管理员；之后用管理员账号登录。初始化后从 Worker 变量和 Secrets 中**删除或轮换**一次性 `BOOTSTRAP_TOKEN`。私有桶的公开访问必须保持关闭。
7. 部署后访问 `/api/v1/health` 和 `/files`；执行 [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md) 的测试，重点测量登录、改密码、密码分享在 Workers Free 下是否出现 CPU 1102 错误。**若存在超限，不要开放公网实际使用；保留 PBKDF2 256 位哈希而不是降低安全性来掩盖错误。**

**免费版默认链接策略：** 不配置任何域名也可创建公开文件直链，例如 `https://你的worker.workers.dev/p/文件发布ID`。这条回退直链每次访问都经过 Worker，受免费版每日请求额度约束；后续如配置 `clouddrive-public` 的 R2 自定义域名及 `PUBLIC_BASE_URL`，新发布的链接可走 R2/CDN。不要将私有 R2 桶绑定公开域名。

**限制与真实状态：** 官方 Deploy Button 需要一个**真正存在、可访问的公开 Git 仓库**，ZIP 文件本身不能直接代替仓库 URL；如果没有你自己的仓库地址，这份代码里的按钮只能作为模板。自动创建资源/自动迁移同样不能替代部署后的安全验收。详见 [`docs/DEPLOY_WINDOWS_CLOUDFLARE.md`](docs/DEPLOY_WINDOWS_CLOUDFLARE.md) 和 [Cloudflare 官方 Deploy Button 文档](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

## 0.2 Worker “128 位密码哈希”核查和登录密码长度

- **官方没有“密码哈希最多 128 位”的通用限制。** Workers Web Crypto 支持 PBKDF2/SHA-256/SHA-384/SHA-512。
- 当前 `worker/services/auth.js` 使用 `PBKDF2-SHA256`、**128 位盐（16 字节）**、**256 位派生哈希（32 字节）**、100,000 次迭代。**登录密码已按需求调整为 6–128 个 Unicode 字符**（包括首次管理员创建、用户创建、登录及修改密码），没有额外的 256 字节截断。此规则是应用要求，不是 Workers 平台对密码哈希长度的限制。
- **真正风险是 Workers Free 单次请求 10 ms CPU 时间。** PBKDF2 登录、密码修改、密码分享会执行派生运算，必须在真实 Cloudflare Free 上检查 Worker 指标；Node/SQLite 模拟测试不能证明满足这一上限。不要因为误解“128 位”而把密码哈希降为弱算法。**分享访问密码仍为独立的至少 12 字符规则**，未与登录密码混为一谈。
- 官方参考：[Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) | [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) | [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

---

# CloudDrive V1（RC2：网页版部署增强）

一个轻量级的多人共享网盘，部署在 Cloudflare Workers Free，使用 **原生 HTML + Bootstrap 5 + ES Modules**；无需 Vue、Vite 或前端编译。后端是 JavaScript Worker，文件保存在 R2，目录和权限保存在 D1。

> **发布状态：候选版本（RC），尚未获得 Windows 真正的 Wrangler/Miniflare 浏览器验收，也未执行任何真实 Cloudflare 账户部署。** 请完成 `docs/TEST_PLAN.md`，尤其验证 PBKDF2 登录是否满足 Workers Free 单次请求 CPU 额度，再用于公开生产环境。46 项 Node 单元测试与 12 项真实 SQLite + 模拟 R2 的 API 集成测试已通过，**不等同于 Cloudflare 线上测试**。

## 1. V1 功能（开发参考）

- 超级管理员首次初始化、用户登录、停用账号、会话与基本登录限流。
- 个人空间、团队共享空间、空间成员与目录级 ACL。
- 文件夹新建、重命名、移动；文件列表、搜索、复制、批量移动。
- 小文件直传私有 R2；大文件 R2 Multipart 上传、暂停/续传和上传失败重试。
- 下载、带 HTTP Range 的文件读取；图片、原生视频和 PDF 预览；预览文件头签名检查。
- 永久公开副本直链（未绑定 R2 CDN 时由 Worker `/p/:id` 提供回退直链）、临时授权直链、带密码的分享页面以及文件夹分享。
- 回收站、恢复、永久删除、过期清理和 R2 删除失败后的持久重试队列。
- 管理员容量上限、空间配额、应用层统计、基础审计与只读一致性诊断。

## 2. 技术与目录

```text
CloudDrive/
├── public/                 # 浏览器直接使用的 HTML / CSS / ES Modules / 本地 Bootstrap
│   ├── index.html          # 后台单页面入口
│   ├── login.html          # 登录和管理员初始化
│   ├── share.html          # 文件/目录公开分享页面
│   ├── css/ js/ vendor/
├── worker/                 # Cloudflare Worker API；原生 JavaScript
│   ├── index.js router.js
│   ├── api/                # 身份、空间、文件、上传、分享、回收站、后台
│   ├── services/           # R2、D1、配额、鉴权与垃圾回收
├── migrations/            # 0001...0011，D1 增量迁移
├── tests/
│   ├── *.test.js          # 46 项 Node 级测试
│   └── integration/       # 12 项使用真实 SQLite SQL 和模拟 R2 的 API 测试
├── scripts/               # Windows .bat 本地、预检、备份、远程迁移、部署
├── docs/                  # 功能、API、部署、测试及安全说明
├── .github/workflows/     # 手动触发的 GitHub Actions 部署
├── .dev.vars.example
├── wrangler.jsonc
└── package.json
```

## 3. Windows 本地首次运行

需要 **Node.js 22 LTS 或更高的兼容版本**（测试代码使用 Node 22 的内置 `node:sqlite`）、npm、Git（可选）和 Chrome/Edge。**不用安装 SQLite 服务，也无需本地运行 R2 服务器。**

1. 解压 ZIP，将 `CloudDrive/` 放到如 `D:\Projects\CloudDrive`。
2. 在 PowerShell 或 CMD 进入根目录，执行：

   ```powershell
   npm install
   Copy-Item .dev.vars.example .dev.vars
   ```

3. 将 `.dev.vars` 内 `BOOTSTRAP_TOKEN` 更改为自行生成的随机长令牌（至少 32 字符），不要提交到代码仓库。
4. 初始化 D1 本地数据库并启动：

   ```powershell
   npm run db:migrate:local
   npm run dev
   ```

5. 打开 `http://localhost:8787/login`，首次填入管理员用户名、6–128 字符密码与上一步令牌。此时 D1/R2 由 Wrangler 在 `.wrangler/state` 中本地保存，**不访问正式 Cloudflare 账户**。
6. 登录后访问 `/files`、`/spaces`、`/shares`、`/trash`、`/settings`。普通文件上传 8 MiB 以内；更大文件自动用 Multipart（应用上限 8 GiB，受剩余配额限制）。

常用命令：

```powershell
npm run check                   # 源码语法
npm test                        # Node 测试
npm run test:integration        # 真实 SQLite + 模拟 R2 集成测试
npm run test:all                # 上述检查合并执行
scripts\preflight.bat          # Windows 预检
scripts\migrate-local.bat      # 本地 D1 迁移
scripts\dev.bat                # 本地 Wrangler 启动
```

**升级前备份** `.wrangler/state`，不要为了迁移而删除它；`wrangler d1 migrations apply ... --local` 会执行尚未应用的 SQL。

## 4. 正式 Cloudflare 部署：CLI 备选（需用户本人账户授权）

操作说明在 [docs/DEPLOY_WINDOWS_CLOUDFLARE.md](docs/DEPLOY_WINDOWS_CLOUDFLARE.md)。部署前必须拥有 Cloudflare 账户并已启用 R2，完成真实 Windows 测试：

```powershell
npx wrangler login
npx wrangler r2 bucket create clouddrive-private
npx wrangler r2 bucket create clouddrive-public
npx wrangler d1 create clouddrive-db
# 将上面获得的 D1 database_id 填入 wrangler.jsonc
npx wrangler secret put BOOTSTRAP_TOKEN
npx wrangler d1 migrations apply clouddrive-db --remote
npx wrangler deploy
```

**以上是说明，未替你执行。** 已有正式数据库时应先 `wrangler d1 export ... --remote` 备份，再应用迁移。R2 私有桶必须保持完全私有。公开直链需要将 `clouddrive-public` 的**自定义域名**绑定到 R2，并在 `wrangler.jsonc` 中设置对应的 `PUBLIC_BASE_URL`；没设置时永久公开文件通过 Worker `/p/{id}` 路由提供直链，限时与密码分享也可正常使用。不要将 `r2.dev` 当成正式 CDN 域名。

## 5. 免费额度策略

默认**应用级**全局 8 GiB 容量软限制（非 Cloudflare 账单限额），包含私有文件和**已发布的公开副本**；同空间逻辑文件复制的 R2 对象共用物理计费。回收站对象仍计入用量；永久删除的 R2 若失败则清理任务会持续占用账面空间，直到完成。

Cloudflare R2 免费标准存储约 10 GB-month/账户（按月平均计费，不是容量硬截止）；Worker Free 通常为 **100,000 请求/天、10 ms CPU/请求**。D1 有单独的读写行额度。公开大文件优先通过自定义 R2 域名访问，私有下载必须经过 Worker。**达到应用 8 GiB 阈值不等于账户不会计费**：未完成分片、孤立对象、R2 操作量等都可能产生费用。请结合 Cloudflare Dashboard 设置账单提醒。

## 6. 安全说明及已知限制

- 运行前验证所有权限；私有下载、预览都要登录或验证分享令牌。密码分享与限时分享始终位于私有桶。
- `PUBLIC_BUCKET` 是真正公开的存储空间，撤销链接不能消除浏览器或 CDN 已保存的副本；需要根据域名配置手动清缓存。
- 服务器仅通过文件头签名检查常见预览格式；这**不是**病毒扫描，也不能证明上传文件完全安全。
- 数据清理已增加持久化 outbox；Multipart 合并成功而 D1 失败时的异常上传仍需要管理员核对，不会静默删除数据。
- 密码登录使用 PBKDF2。**尚未验证 Workers Free 10 ms CPU 限额下的真实表现**，可能要求改用更合适的认证设计或者付费计算环境。
- 过度复杂的目录树、并发权限撤销/上传、CDN 缓存失效、浏览器视频解码兼容和真正的 Windows 端到端测试仍需按发布验收清单检查。
- 这里只提供源码与部署步骤，**不包含已运行的 Cloudflare 线上实例，不包含账户密钥**。

## 7. 其他文档

- [Windows + Cloudflare 部署](docs/DEPLOY_WINDOWS_CLOUDFLARE.md)
- [密码学 128 位核查与一键部署](docs/CRYPTO_AND_ONE_CLICK.md)
- [第十二阶段验收测试](docs/TEST_PLAN.md)
- [安全设计与上线阻断项](docs/SECURITY.md)
- [运维与恢复](docs/OPERATIONS.md)
- [第十二阶段变更摘要](docs/STAGE12_CHANGES.md)
- 历史设计：`docs/API.md`、`docs/DATABASE.md`、`docs/STORAGE.md`、`docs/MULTIPART.md`、`docs/SHARING.md`、`docs/TRASH.md`、`docs/ADMIN.md`。
