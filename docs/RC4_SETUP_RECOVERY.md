# CloudDrive RC4：Cloudflare 首次部署后登录页无限跳转、D1 未迁移修复

## 真实故障与原因

1. `/api/v1/health/ready` 显示 `D1_MIGRATIONS_REQUIRED`, `schema_ready:false`，而 D1/R2/ASSETS 均为 `true`：**真实 Cloudflare D1 已绑定，但数据库结构未通过 Wrangler 的远程 SQL 迁移创建**。Binding 就绪不等于数据库表就绪。
2. `/setup` 跳转 `/login`，浏览器出现 `ERR_TOO_MANY_REDIRECTS`：源代码 `worker/index.js` 在响应 `/login`、`/setup` 时调用 `env.ASSETS.fetch('/login.html')`。Cloudflare Static Assets 默认 `html_handling: auto-trailing-slash`，会把 `/login.html` 重定向至 `/login`，随后 Worker 再次访问 `/login.html`，形成 307 循环。`/index.html` 与 `/share.html` 同理。

**RC4 修改：** `wrangler.jsonc` 的 `assets.html_handling` 改成 `none`。这样 `env.ASSETS.fetch('/login.html')` 直接返回 HTML (200)。Worker 增加非预期跳转保护；登录页面先调用 `/api/v1/health/ready`，明确显示 D1 迁移/初始化 Secret 等状态，在后端未就绪时不展示无效的登录表单。

## 现有 Cloudflare Worker 的修复流程（推荐：完全通过网页控制台）

1. 将 RC4 文件合并到与你的 Cloudflare Worker 关联的 GitHub 仓库，并 `git push` 到该 Worker 对应的分支。切勿误操作另一个自动克隆的仓库。
2. 登录 Cloudflare Dashboard → Workers & Pages → 找到实际运行网站的 Worker（可能叫 `cloudflare-disk`，以 `workers.dev` 域名为准） → Settings → Builds。
3. 确认 Git 仓库、分支正确。**Build Command 留空；此次故障恢复将 Deploy Command 设置为 `npm run deploy:upgrade`**（因为你的现有 D1 Binding 已创建，避免重复资源初始化）。该命令先执行迁移，再发布新版 Worker。
4. 不要新建/删除 `clouddrive-db`、`clouddrive-private`、`clouddrive-public`。确认 `DB` Binding 指向当前现有 D1。若现有 D1 里有真实数据，先备份。
5. 在 Deployments 中触发新版本部署，查看日志中 `db:migrate:remote`、`wrangler d1 migrations apply DB --remote` 和迁移成功的记录。只有上传静态资源、显示 D1/R2 Bindings 并不代表执行了迁移。
6. 如果迁移失败，停止操作并记录完整报错。重点检查是否为“缺少 D1 database_id”、“无法找到 DB Binding”、“认证或权限不足”或 SQL 迁移语法错误。**不要执行手工建表来掩盖问题，也不要创建同名新 D1 代替原有 D1**。
7. 迁移后访问 `https://cloudflare-disk.2948531734.workers.dev/api/v1/health/ready`，预期下一步为 `BOOTSTRAP_SECRET_REQUIRED`（密钥尚未配置）或 `ADMIN_SETUP_REQUIRED`（密钥已配置）。
8. Cloudflare Dashboard → Worker → Settings → Variables and Secrets，添加 Secret `BOOTSTRAP_TOKEN`，随机至少 32 字符；保存后访问 `/setup` 或 `/login`。两者均直接显示网页登录页面，不应出现重定向循环。输入用户名（3–40 个英文数字/下划线/连字符）、密码（6–128 个 Unicode 字符）和初始化密钥创建首个超级管理员。
9. 首次创建成功后 `/api/v1/health/ready` 应返回 `READY`。进入 `/files` 做权限、上传、预览等实际测试。建议初始化完成后删除/轮换 `BOOTSTRAP_TOKEN`。
10. 修复成功后，Deploy Command 可改回 `npm run deploy` 以保持项目后续的自动首次部署/升级逻辑；现有数据库仍应优先执行迁移、再发布新 Worker。

### 备用方案：只迁移已存在 D1（本地 Windows PowerShell）

只有 Cloudflare 网页重新部署未能迁移时，才需要本地命令；这不会改动已上传的 R2 文件。

```powershell
cd D:\Python\b01-website\web-all\CloudDrive
npm install
npx wrangler login
npx wrangler d1 migrations list DB --remote
npx wrangler d1 migrations apply DB --remote
```

注意：上面命令必须引用已部署 Worker 正在使用的同一个 D1，避免给错误数据库写表。`npx wrangler login` 需要访问 Cloudflare OAuth；如果你的终端必须走本地 HTTP 代理，先在当前 PowerShell 临时设置 `$env:HTTPS_PROXY='http://127.0.0.1:10080'`，任务结束后恢复原值。不要全局配置代理。

### 进一步诊断

Cloudflare 官方 HTML 路由说明：<https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/>

Cloudflare 官方 D1 迁移命令说明：<https://developers.cloudflare.com/d1/wrangler-commands/#d1-migrations-apply>

Cloudflare 官方 Deploy to Cloudflare 按钮说明：<https://developers.cloudflare.com/workers/platform/deploy-buttons/>

无必要清除浏览器 Cookie。当前两个问题源自 Worker 端的 HTML 路由和 D1 表结构，而不是 Cookie 本身。
