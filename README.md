# CloudDrive — 私有网盘、团队空间与 OneDrive 直链分享

CloudDrive 是基于 **Cloudflare Workers + D1 + R2 + Static Assets** 的文件管理和分享应用，提供个人/团队空间、权限控制、文件预览、断点续传、版本管理、回收站、公开分享与 OneDrive 文件分享。前端为原生 HTML/CSS/JavaScript 和 Bootstrap，不需要额外打包。**全部时间在数据库中按 UTC 保存，浏览器根据本机时区显示。**

**本仓库采用单文件数据库初始化**：`migrations/0001_initial.sql` 包含当前完整结构。首次部署只需要执行此文件。对于已经运行过全部历史迁移的数据库，沿用同名 `0001_initial.sql` 的迁移记录，保留全部现有记录。旧数据库如果只执行了部分历史迁移，部署会检查并**停止**，不会自动删除用户文件、分享链接、D1 表或 R2 桶。

## 1. 主要功能

| 模块 | 能力 |
| --- | --- |
| 账号与权限 | 超级管理员、成员、登录会话、6–128 个 Unicode 字符密码、PBKDF2-SHA256、文件夹 ACL、容量限制 |
| 文件管理 | 文件夹树、双击进入、多级目录、列表/网格、搜索、排序、上传、批量操作、收藏、最近文件 |
| 个人与团队 | `/personal` 和 `/files` 共用文件管理组件；`/spaces` 管理团队及权限 |
| R2 存储 | 私有/公开双桶、分片上传、断点续传、图片/PDF/视频预览、Range 下载 |
| 分享 | 临时链接、固定直链、密码分享、分享页面、有效期/次数、公开副本和 CDN 可选接入 |
| 版本与恢复 | 文件替换保留逻辑 ID、历史版本、文本编辑、回收站、定期清理 |
| OneDrive | 管理员 OAuth、云端目录/缩略图/搜索、文件和合集分享、公开链接解析、固定入口、预览、同步健康检查 |
| 运维 | 空间配额、审计与异常日志、备份登记、健康检查、Cron 清理和同步 |

主要页面：`/login`、`/setup`、`/files`、`/personal`、`/spaces`、`/shares`、`/trash`、`/onedrive`（管理员 OneDrive 文件）、`/tools/onedrive`（分享链接解析）、`/settings?tab=onedrive`（Microsoft 配置）。

更多功能介绍：[文件和分享](docs/FILES_AND_SHARING.md) · [OneDrive](docs/ONEDRIVE.md) · [管理与安全](docs/ADMIN_AND_SECURITY.md) · [API](docs/API.md)。`docs/` 不再包含版本迭代记录。

## 2. 目录结构与重要文件

| 路径 | 用途 |
| --- | --- |
| `worker/index.js`, `worker/router.js` | Worker 入口、静态路由、API 分发、Cron |
| `worker/api/`, `worker/services/` | 业务 API、权限、OneDrive、R2 与运维服务 |
| `public/` | HTML、CSS、JavaScript、静态资源 |
| `migrations/0001_initial.sql` | **唯一**数据库初始化 SQL，包含完整现有表、索引和触发器 |
| `scripts/schema-baseline.json` | 当前表/列/索引清单，用于部署前防止旧库结构不完整 |
| `scripts/deploy-cloudflare.mjs` | 自动匹配远程 D1、检查结构、迁移后再部署 |
| `scripts/check-migrations.mjs` | 拒绝未经确认的 DROP / DELETE 等破坏性 SQL |
| `wrangler.jsonc` | Worker 名称、D1/R2/Assets 绑定、Cron 与 Text 变量保留配置 |
| `.dev.vars.example` | 本地 Secret 模板；复制为 `.dev.vars` 并填写真实值 |
| `scripts/` | 备份、恢复、检查、部署等工具 |
| `tests/` | 单元测试、SQLite/D1 模拟集成测试与安全回归 |

> **数据不要和源码混淆**：正式 Cloudflare 数据存放在 D1/R2；Ubuntu 本地模拟数据存放在 `.wrangler/state/`。只更新源码不会自动复制生产文件。生产部署必须保留原 Worker 名称、D1 数据库绑定、R2 桶及 Secret。

## 3. 部署方案 A：Cloudflare Workers（正式推荐）

### 3.1 准备环境

1. 在 Cloudflare 创建账户，启用 Workers、D1 和 R2，并准备可选的自定义域名。
2. 将本仓库上传到 GitHub，或在 Node.js **22** 环境中拉取项目：

   ```bash
   git clone https://github.com/OWNER/REPOSITORY.git clouddrive
   cd clouddrive
   npm install
   ```

3. 打开 `wrangler.jsonc` 检查 `name`（目标 Worker）、`d1_databases[].database_name`（默认 `clouddrive-db`）、两个 `r2_buckets[].bucket_name`（默认 `clouddrive-private`、`clouddrive-public`）。对旧站点请保持它们不变。
4. 将 `BOOTSTRAP_TOKEN` 以 **Worker Runtime Secret** 配置到目标 Worker；首次创建管理员必须有这个值。建议使用安全随机的 64 位十六进制字符串。注意该变量不是 Build 环境变量。
5. 可选 `SHARE_LINK_KEY`（32 字节随机数，64 位十六进制）用于新分享链接的安全恢复；使用后不要随意更换。

### 3.2 Cloudflare 网页通过 Git 部署

Cloudflare 控制台 → **Workers & Pages** → 创建或选择 Worker → **Settings → Builds**：

| 项目 | 设置 |
| --- | --- |
| Git 仓库与分支 | 你的 CloudDrive 仓库 / `main`（按实际配置） |
| Root Directory | 仓库根目录 `/` |
| Build Command | `npm run build` |
| Deploy Command | **`npm run deploy`** |

**不要将 Deploy Command 改成单独的 `wrangler deploy`**；本仓库的 `npm run deploy` 会检查 D1、按需初始化，并先完成数据库校验后再部署 Worker。Cloudflare Git 构建不负责将用户在本地修改的源码自动上传到 Git；需推送仓库。

项目同时保留根目录 `deploy-link.html`，用于展示 Deploy to Cloudflare 的入口说明；不要将其中的仓库地址视为所有用户通用。

### 3.3 命令行部署

```bash
npx wrangler login           # 本机交互式授权 Cloudflare
npm run build                # 语法、迁移安全扫描及自动化测试
npm run deploy               # 自动识别现有 D1，执行待执行迁移，再发布 Worker
```

首次自动创建资源依赖 Cloudflare 账户配额、授权及资源创建权限。若现有数据库已绑定真实 `database_id`，部署脚本会核对其是否与云端一致，不会因列表查询失败而创建替代数据库。

部署后访问：

```text
https://你的域名/api/v1/health/ready
https://你的域名/setup
https://你的域名/files
```

出现 `BOOTSTRAP_SECRET_REQUIRED`：检查 Worker 运行时 Secret；出现 `ADMIN_SETUP_REQUIRED`：到 `/setup` 输入管理员用户名、6–128 Unicode 字符密码和 `BOOTSTRAP_TOKEN`；返回 `READY`：基础结构和管理员已建立。`READY` 不代表 OneDrive 下载/大文件上传已经真实联调通过。

### 3.4 绑定与环境变量

| 配置 | 类型/位置 | 作用 |
| --- | --- | --- |
| `DB` | `wrangler.jsonc` D1 binding | 用户、文件、空间、分享、索引和运维元数据 |
| `PRIVATE_BUCKET` | R2 binding | 私有文件桶，**禁止直接公开** |
| `PUBLIC_BUCKET` | R2 binding | 明确公开发布的 R2 副本 |
| `ASSETS` | Static Assets binding | 网页、CSS、JS |
| `BOOTSTRAP_TOKEN` | Secret（首次配置必需） | 第一个超级管理员初始化凭证 |
| `SHARE_LINK_KEY` | Secret（建议） | 新建分享链接的可恢复加密密钥 |
| `APP_NAME` / `APP_STAGE` | Text，`wrangler.jsonc` | 站点名称、版本诊断标识 |
| `PUBLIC_BASE_URL` | Text（可选） | 公开桶 CDN 的 HTTPS 根地址 |
| `MS_CLIENT_ID` | Text 或 Secret（开启 OneDrive 授权后必需） | Microsoft Entra Application (client) ID |
| `MS_CLIENT_SECRET` | Secret | Microsoft Entra 客户端密码 **Value** |
| `MS_TOKEN_KEY` | Secret，32 字节随机数 | 加密保存 Microsoft OAuth 令牌；更换后旧授权可能失效 |
| `MS_TENANT` / `MS_REDIRECT_URI` | Text（可选） | OAuth 账户类型和固定 HTTPS 回调 |
| `CDN_ZONE_ID` / `CDN_PURGE_TOKEN` | 可选配置与 Secret | 撤销公开 CDN 链接时触发缓存清除 |

**重要**：配置中的 `keep_vars: true` 与自动部署命令 `--keep-vars` 用于保留 Cloudflare Dashboard 中手工添加的 Text 环境变量；Secrets 必须绑定同一 Worker/环境，不要将 Secret 值上传 GitHub。微软授权配置在 `/settings?tab=onedrive`，每项下方都有说明。

### 3.5 Cloudflare 升级、备份和恢复

```bash
npm run db:migrations:list:remote   # 查看待执行的 SQL
npm run db:backup:remote           # 将远程 D1 导出为 backups/ 下的 SQL 备份
npm run db:migrate:remote          # 只执行远程 SQL，不部署 Worker
npm run deploy:upgrade            # **只升级已存在**的目标 D1，缺失则停止
npm run deploy                     # 已存在则升级，不存在则首次初始化
```

升级前应先备份 D1 和 R2；`db:backup:remote` **只包含 D1，不包含 R2 文件**。R2 备份需另外导出两个桶。保留 D1 的文件 ID 与 R2 的对象，否则历史文件和直链可能断开。

## 4. 部署方案 B：Ubuntu / Debian（本地兼容运行）

**兼容性说明**：本仓库的正式后端基于 Workers、D1、R2 原生 API，目前**没有独立的 Ubuntu 原生生产服务端及原生对象存储适配器**。Ubuntu 上可运行 Wrangler 的本地 Workers 兼容环境，并将本地 D1/R2 状态持久化在磁盘，适用于开发、功能验证和低流量受控测试；**不建议将此模拟方式用于长期生产公开网盘**。如要求 Ubuntu 正式生产版，需要单独开发 SQLite/对象存储/任务调度的原生适配、运维和安全验证。

### 4.1 安装与初始化（Ubuntu 22.04/24.04）

```bash
# 建议以普通用户运行，不要 root 常驻 Node 服务
sudo apt update
sudo apt install -y git curl ca-certificates nginx
# 安装 Node.js 22（可选使用 nvm 或官方 NodeSource；此处使用 nvm）
export NVM_DIR="$HOME/.nvm"
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install 22
node -v && npm -v

git clone https://github.com/OWNER/REPOSITORY.git ~/clouddrive
cd ~/clouddrive
npm install
cp .dev.vars.example .dev.vars
chmod 600 .dev.vars
# 编辑 .dev.vars，将示例 BOOTSTRAP_TOKEN 改为真实随机 Secret
nano .dev.vars
npm run ubuntu:migrate
npm run ubuntu:start
```

首次访问 `http://127.0.0.1:8787/setup`，完成管理员初始化。**不要在 Ubuntu 直接运行 `npm run deploy`，它会连接 Cloudflare 远程环境。**

### 4.2 Ubuntu 数据目录与备份

- `./.wrangler/state/`：本地 D1、R2 等运行状态；`ubuntu:migrate` 和 `ubuntu:start` 必须使用**同一** `--persist-to` 路径（脚本已设置）。
- `./.dev.vars`：本地运行时密钥，权限设为 `600`，绝不提交 Git。
- `./public/`、`./worker/`：前端和 Worker 源码；`./migrations/0001_initial.sql`：首次初始化结构。
- 停止服务后备份整个 `.wrangler/state/` 和私密保存的 `.dev.vars`；D1 导出可用：

  ```bash
  mkdir -p backups
  npx wrangler d1 export clouddrive-db --local --persist-to ./.wrangler/state --output backups/local-d1.sql
  ```

只导出 D1 不足以备份本地 R2 文件；保存整个本地状态目录更容易一致恢复。

### 4.3 Nginx 反向代理（仅受控测试部署）

可通过 Nginx 把域名 HTTPS 请求转发到仅监听 `127.0.0.1:8787` 的测试服务。将下列 `server_name` 改为自己的域名，并通过 DNS 解析到此 Ubuntu 主机：

```nginx
server {
    listen 80;
    server_name drive.example.com;
    client_max_body_size 128m;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

保存到 `/etc/nginx/sites-available/clouddrive`，软链至 `sites-enabled`，运行 `sudo nginx -t && sudo systemctl reload nginx`。如需公网 HTTPS，使用 `certbot --nginx -d drive.example.com` 获取证书。仅供兼容调试，**不要把 Wrangler 开发端口 8787 直接暴露公网**。

### 4.4 systemd 测试服务

使用 `command -v node` 和 `command -v npm` 找到实际路径。以普通用户运行；如用 nvm 安装 Node，需在 `Environment=PATH=...` 中配置该用户的 Node 路径。示例 `/etc/systemd/system/clouddrive-local.service`：

```ini
[Unit]
Description=CloudDrive Wrangler local compatibility environment
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/clouddrive
Environment=HOME=/home/YOUR_USER
Environment="PATH=/home/YOUR_USER/.nvm/versions/node/v22.16.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"
ExecStart=/home/YOUR_USER/.nvm/versions/node/v22.16.0/bin/npm run ubuntu:start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

将 `YOUR_USER` 和 Node 版本路径改为实际值。执行 `sudo systemctl daemon-reload && sudo systemctl enable --now clouddrive-local`，查看 `journalctl -u clouddrive-local -f`。这不是承诺适用于大规模生产或高可用场景的 systemd 后端部署。

## 5. 单 SQL 初始化、历史数据库和“格式化”方案

`migrations/` 只包含 **`0001_initial.sql`**。该文件由历史迁移执行后的最终 SQLite 结构生成，包含当前应用需要的表、索引、触发器及初始配置。`scripts/schema-baseline.json` 记录结构要求。升级前会检查远程库：

1. **全新空库**：执行单 SQL 并创建完整表结构。
2. **已经完成原有全部历史迁移的旧库**：Wrangler 记录中已存在 `0001_initial.sql`，会跳过此文件；脚本再次核对表、列、索引与触发器，保留原用户/文件/分享记录。
3. **旧库只迁移了一部分 / 有残留缺字段 / 部分索引缺失**：自动部署立即停止。先使用原有旧版源码补齐历史迁移至完整结构，再切换此版；或者备份后明确选择全新数据库。不要运行新的基线来试图“修补”一半升级的旧库。
4. **主动放弃旧库、重新初始化**：先备份 D1 + R2 + 机密变量；在 Cloudflare 创建**新名称**的 D1（或改用新的 Worker/项目），调整 `wrangler.jsonc` 的 D1 `database_name` 并移除旧 `database_id`，让脚本对新库初始化。不要直接删除原数据库。确认新系统有效后才考虑手动删除原资源。新库不含旧用户、分享和对象元数据，不能指望旧 R2 对象自动恢复索引。

**该方案默认不会自动清空线上数据**。若你的旧库并不完整且希望保留数据，请使用前一版完整代码执行其历史迁移链，而不是通过 SQL `DROP` 或覆盖 `d1_migrations` 伪造迁移历史。**以后如需新增数据库字段，仅修改此 `0001_initial.sql` 不会升级已经执行过它的数据库**；未来仍须单独准备经过审核的增量升级脚本，或在明确接受丢失历史数据后使用全新 D1。

本地临时测试库可直接停止 Wrangler 后备份/删除 `.wrangler/state/`，再次运行 `npm run ubuntu:migrate`；这只影响本地模拟数据，**不可用于生产 D1**。不应删除 `d1_migrations` 表来强迫旧库重跑初始化。

### 5.1 如果使用“文档/迁移清理”增量补丁

本次涉及**删除过时的 Markdown 与多余 SQL 迁移文件**。仅将 ZIP 内容覆盖旧目录不会删除旧文件。增量补丁附带 `apply-cleanup.mjs` 和 `payload/`，必须使用清理脚本：

```bash
# 解压补丁后，在补丁目录执行，路径替换为真实项目目录
node apply-cleanup.mjs /path/to/clouddrive
# 或在 Windows PowerShell：node .\apply-cleanup.mjs 'D:\CloudDrive'
cd /path/to/clouddrive
npm run build
```

脚本会先把被替换/删除的**源码与文档**备份到项目目录的上一级独立文件夹，再写入修改文件并清理多余 `.md`、旧 SQL 和只用于历史迁移链的测试；不会连接 Cloudflare、不会删除 D1/R2，也不会覆盖 `wrangler.jsonc` 或 `.dev.vars`。请先检查差异、备份生产 D1/R2，然后再 `npm run deploy`。**不要直接把 `payload/` 当成完整项目运行。**

## 6. 命令 / 函数用法速查

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装 Wrangler 及测试依赖 |
| `npm run build` | 迁移安全扫描 + 单元/集成回归测试，不执行生产迁移 |
| `npm run check` | 运行 JS 语法检查 |
| `npm run test:all` | 运行所有本地自动化测试 |
| `npm run check:migrations` | 审核初始化 SQL 中是否有潜在破坏性语句 |
| `npm run dev` | Windows/macOS/Linux 本地 Wrangler 开发模式 |
| `npm run ubuntu:migrate` | 初始化 Ubuntu 本地 D1（持久化路径与 `ubuntu:start` 一致） |
| `npm run ubuntu:start` | Ubuntu 本地兼容模式，绑定 127.0.0.1:8787 |
| `npm run ubuntu:check:migrations` | 查看 Ubuntu 本地 D1 待执行 SQL |
| `npm run deploy` | Cloudflare 自动解析绑定 → 验证数据库 → 迁移 → 部署 |
| `npm run deploy:initial` | Cloudflare 首次部署入口 |
| `npm run deploy:upgrade` | 仅升级现有目标 Cloudflare D1 |
| `npm run db:migrate:remote` | 只对现有远程 D1 迁移 |
| `npm run db:migrations:list:remote` | 查看远程待迁移项 |
| `npm run db:backup:remote` | 导出远程 D1（R2 需另备份） |

### 常用 HTTP 调用

```bash
# 服务健康状态及数据库初始化状态
curl -fsS https://drive.example.com/api/v1/health/ready

# 以下接口需要合法会话与授权；示例 UUID 为占位符
curl -b cookies.txt 'https://drive.example.com/api/v1/spaces/SPACE_UUID/contents?parent_id=&offset=0&limit=50'
```

`GET /api/v1/spaces/{spaceId}/contents` 同时返回子文件夹和文件；`/personal` 与 `/files` 使用相同组件，但受各自空间选择及服务器 ACL 约束。API 的权限、请求与响应格式请见 [docs/API.md](docs/API.md)。

## 7. 使用限制与验收

- **Cloudflare Workers 是正式目标平台**；Ubuntu 的 Wrangler 本地兼容运行不具备原生生产版的部署/高可用/安全承诺。
- Microsoft Graph 需要有效授权；OneDrive 公开分享、企业权限、下载地址有效期和 Graph 限流都可能影响可用性。固定的是 CloudDrive URL，而不是微软原始 URL。
- 更新生产代码或迁移前请先测试 `/api/v1/health/ready`、管理员登录、文件上传/下载、`/personal` 目录列表、OneDrive 文件分享与撤销，并备份 D1、R2 和 Token 加密密钥。
- SQLite/D1 结构归并已在本地通过单文件初始化及数据保留测试；真实生产升级仍应在测试库验证。不能把本地测试结果当成已经修改线上数据库。
