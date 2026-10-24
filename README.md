# CloudDrive V1 RC3 — Cloudflare 网页一键部署（无需前端编译）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/biao169/cloudflare_disk)

**官方一键部署：** https://deploy.workers.cloudflare.com/?url=https://github.com/biao169/cloudflare_disk

源代码仓库：<https://github.com/biao169/cloudflare_disk>。项目采用 **HTML + Bootstrap + 原生 JavaScript + Cloudflare Worker**，无需 Vue、Vite、前端编译或单独构建命令。

## 0.1 首次网页版部署（新 Cloudflare 账户）

1. 打开上方 **Deploy to Cloudflare**，登录 Cloudflare/GitHub；确认仓库根目录含 `package.json`、`wrangler.jsonc`、`public/`、`worker/`、`migrations/`。
2. 选择 Workers Free。启用 R2 服务可能需要先接受 Cloudflare 的计费/支付要求；不保证完全无费用。系统默认准备两个 R2 桶和一个 D1：
   - `PRIVATE_BUCKET` → `clouddrive-private`（绝对不能开启公开访问）
   - `PUBLIC_BUCKET` → `clouddrive-public`（只放主动发布的公开文件）
   - `DB` → `clouddrive-db`
3. **Build Command 留空**；**Deploy Command 设置为 `npm run deploy`**，**不要填 `npx wrangler deploy`**（后者不会自动执行数据库迁移）。该脚本会先检测现有 D1：已有可用数据库则先迁移后部署；首次资源尚未可用时先由 Wrangler 创建资源，再迁移 D1。
4. 仔细确认部署日志最终含 **Worker published/deployed** 及迁移完成信息。日志显示静态文件上传、R2 桶创建、Binding 列表，**不代表整个部署结束**。
5. 在 Cloudflare Dashboard → Workers & Pages → `clouddrive` → **Settings → Variables and Secrets**，添加 **Secret**：`BOOTSTRAP_TOKEN`，值为 32 字符以上的强随机字符串（不要填示例占位符，也不要提交 Git）。如果部署向导已询问并保存了该 Secret，则无需重复添加。
6. 打开 `https://你的worker.workers.dev/api/v1/health/ready` 检查数据库与初始化状态。返回 `ADMIN_SETUP_REQUIRED` 表示可继续访问 `/login` 创建管理员；成功创建超级管理员后就绪检查应返回 `200 READY`。
7. 首次管理员初始化完成后可删除或轮换 `BOOTSTRAP_TOKEN`。测试上传、预览、分享、下载和回收站。登录采用 PBKDF2-SHA256，需要在真实 Workers Free 环境验证 10 ms CPU 限额，**未验证前不要开放公众正式使用**。

**Cloudflare 官方资料：** [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/) · [自动资源配置](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/) · [D1 迁移](https://developers.cloudflare.com/d1/platform/client-api/)。

## 0.2 从 Cloudflare 部署日志判断卡在哪一步

| 现象 | 判断与处理 |
|---|---|
| `Uploaded ... assets` | 仅表示静态资源上传完毕，不能判断 Worker 已上线 |
| `R2 Bucket provisioned` | R2 创建成功，不要重复创建桶 |
| `env.DB (clouddrive-db)` | 仅证明绑定存在，不等于 D1 数据表完成迁移 |
| `PUBLIC_BASE_URL ("")` | **不是错误**：未设置自定义 CDN 时使用 Worker `/p/{id}` 公开直链 |
| `/api/v1/health` 返回 200 | 只代表 Worker 运行，不代表数据库就绪 |
| `/api/v1/health/ready` 返回 `D1_MIGRATIONS_REQUIRED` | 检查部署命令是否为 `npm run deploy`，并核对 D1 迁移日志；可用 `npx wrangler d1 migrations apply DB --remote` 在已绑定数据库上执行迁移 |
| 返回 `BOOTSTRAP_SECRET_REQUIRED` | 在 Worker 后台配置 Secret `BOOTSTRAP_TOKEN` |
| 返回 `ADMIN_SETUP_REQUIRED` | 访问 `/login` 初始化第一位管理员 |
| 返回 `READY` | 绑定与基础数据库初始化已通过；仍需浏览器实际测试 |

详细诊断见 [`docs/DEPLOY_TROUBLESHOOTING.md`](docs/DEPLOY_TROUBLESHOOTING.md)。

**升级已有 Cloudflare 实例：** 先备份生产 D1/R2，再执行 `npm run deploy:upgrade`（迁移先行）；如果远程数据库已存在且可列出迁移，默认 `npm run deploy` 也会先迁移。若数据库访问异常，不要把升级当作“首次部署”强行运行，防止短暂运行未迁移的新代码。

**关于 D1 ID：** 本仓库不再提交假的 `database_id` UUID，使用 Wrangler 4.45+ 的资源自动配置。Cloudflare 自动部署会关联真实数据库；已有运行实例升级时需要核对 `DB` 仍然指向原数据库，**切勿创建同名的新数据库替代已有数据**。在 Windows 上手工管理 D1 时，按实际账户配置真实 ID。

**注意：** 部署后还需要上传及登录测试。R2 公开直链 `PUBLIC_BASE_URL` 为空时通过 Worker `/p/{id}` 回退，不是阻断部署的配置项。

---

## 0.2 Worker “128 位密码哈希”核查和登录密码长度

- **官方没有“密码哈希最多 128 位”的通用限制。** Workers Web Crypto 支持 PBKDF2/SHA-256/SHA-384/SHA-512。
- 当前 `worker/services/auth.js` 使用 `PBKDF2-SHA256`、**128 位盐（16 字节）**、**256 位派生哈希（32 字节）**、100,000 次迭代。**登录密码已按需求调整为 6–128 个 Unicode 字符**（包括首次管理员创建、用户创建、登录及修改密码），没有额外的 256 字节截断。此规则是应用要求，不是 Workers 平台对密码哈希长度的限制。
- **真正风险是 Workers Free 单次请求 10 ms CPU 时间。** PBKDF2 登录、密码修改、密码分享会执行派生运算，必须在真实 Cloudflare Free 上检查 Worker 指标；Node/SQLite 模拟测试不能证明满足这一上限。不要因为误解“128 位”而把密码哈希降为弱算法。**分享访问密码仍为独立的至少 12 字符规则**，未与登录密码混为一谈。
- 官方参考：[Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) | [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) | [Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。

---

# CloudDrive V1（RC3：自动部署和就绪诊断增强）

一个轻量级的多人共享网盘，部署在 Cloudflare Workers Free，使用 **原生 HTML + Bootstrap 5 + ES Modules**；无需 Vue、Vite 或前端编译。后端是 JavaScript Worker，文件保存在 R2，目录和权限保存在 D1。

> **发布状态：候选版本（RC），尚未获得 Windows 真正的 Wrangler/Miniflare 浏览器验收，也未执行任何真实 Cloudflare 账户部署。** 请完成 `docs/TEST_PLAN.md`，尤其验证 PBKDF2 登录是否满足 Workers Free 单次请求 CPU 额度，再用于公开生产环境。46 项 Node 单元测试与 18 项真实 SQLite + 模拟 R2 的 API 集成测试已通过，**不等同于 Cloudflare 线上测试**。

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
