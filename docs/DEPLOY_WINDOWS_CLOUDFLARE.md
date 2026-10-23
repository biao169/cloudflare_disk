# Cloudflare 网页端一键自动部署（推荐）

官方入口：[Deploy to Cloudflare](https://developers.cloudflare.com/workers/platform/deploy-buttons/)。先将仓库根目录（含 `package.json`、`wrangler.jsonc`、`public/`、`worker/`、`migrations/`）上传到**公开** GitHub/GitLab 仓库，然后在 解压后 `CloudDrive/deploy-link.html` 输入真实仓库 URL 并打开官方部署页。

- Cloudflare 读取 `wrangler.jsonc`，自动创建 `DB`（D1）和 `PRIVATE_BUCKET`、`PUBLIC_BUCKET`（R2）绑定及相应资源。为本账户开通 R2 可能需要完成服务和计费确认。
- **Build Command 留空**（无需 Vue/Vite 构建），**Deploy Command 为 `npm run deploy`**。`package.json` 已配置 `wrangler d1 migrations apply DB --remote` 后再执行 `wrangler deploy`，新实例能够初始化数据库。现有真实数据升级应先备份 D1/R2，再确认迁移兼容性；不要无审查地对生产数据开启自动迁移。
- 部署流程如果弹出 `BOOTSTRAP_TOKEN` 密钥输入框，填写自行生成的随机长令牌。否则部署后去 **Workers & Pages → 对应 Worker → Settings → Variables and Secrets → Add → Secret** 手动添加；切勿把真实令牌写入仓库。
- 访问生成的 `workers.dev/login`，使用初始化密钥创建第一位超级管理员，然后删除/轮换令牌。
- **没有自定义域名也支持公开直链**：新发布文件使用 Worker `/p/{id}` 路由（占用免费 Worker 请求）。如果设置 R2 公开桶自定义域名和 `PUBLIC_BASE_URL`，新的永久链接可直接经由 R2/CDN。私有桶不得公开。
- 最后检查登录是否超过免费版单请求 10 ms CPU：当前 PBKDF2 为 100,000 次，尚未取得 Workers Free 的真实 CPU 测量结果。出现 1102 时暂停公网使用，不能随意用简单 SHA-256 替代密码 KDF。

**官方 Deploy Button URL 需真实公开仓库**，ZIP 不是 URL：

```text
https://deploy.workers.cloudflare.com/?url=https://github.com/你的用户名/你的公开仓库名
```

---

# Windows 开发、Cloudflare Workers Free 部署与升级

## A. Windows 本地预检

要求 Node.js 22 LTS/更新兼容版本、npm；`node -v` 和 `npm -v` 有输出。项目无需 Vue/Vite/TypeScript 前端构建。

```powershell
cd D:\Projects\CloudDrive
npm install
Copy-Item .dev.vars.example .dev.vars  # 首次运行
# 编辑 .dev.vars：设置随机的 BOOTSTRAP_TOKEN
npm run db:migrate:local
npm run test:all
npm run dev
```

在 Chrome/Edge 中访问 `http://localhost:8787/login`，初始化管理员并跑 `docs/TEST_PLAN.md` 的完整清单。单独的 `npm run test:integration` 只使用 Node 原生 SQLite + 模拟 R2，不代表 Wrangler 已经通过。

本地 D1 与 R2 位于 `.wrangler/state`（Wrangler 管理的路径），不要在升级时删除，重要测试数据请备份整个目录；`npx wrangler d1 migrations apply clouddrive-db --local` 不会操作远程数据库。

## B. 正式账户首次部署

1. 在 Cloudflare Dashboard 注册/登录账户，确认账户的 Workers 与 R2 已启用；R2 可能要求开通对应服务或付款方式。确认自己接受可能的超额费用。
2. 在 Windows PowerShell 的项目根目录运行：

```powershell
npx wrangler login
npx wrangler whoami
npx wrangler r2 bucket create clouddrive-private
npx wrangler r2 bucket create clouddrive-public
npx wrangler d1 create clouddrive-db
```

3. 将创建 D1 时输出的**真实 UUID**写入 `wrangler.jsonc` 里的 `database_id`；勿保留 `00000000-0000-0000-0000-000000000001` 示例值。确保 Bucket 名称与 `r2_buckets` 匹配。
4. 在 Dashboard 中确认 `clouddrive-private` 没有公开域名或 `r2.dev` 开关，之后仍然保持私有。公网匿名访问必须只发生在 `clouddrive-public`。
5. 为 Worker 保存初始化密钥（这里会交互式输入，不要将明文写入 Git）：

```powershell
npx wrangler secret put BOOTSTRAP_TOKEN
```

6. 首次安装新 D1 时进行远程迁移（已有数据库升级，先看 C 节）：

```powershell
npx wrangler d1 migrations apply clouddrive-db --remote
npx wrangler deploy
```

7. 访问 Wrangler 输出的 `https://<worker-name>.<subdomain>.workers.dev/login`（或者你在 Cloudflare 配置的 Worker 自定义域名），初始化超级管理员。将管理员密码和密钥安全保存，设置成功后考虑**轮换或删除** Bootstrap Token。
8. 如果需要永久公开直链，在 Cloudflare R2 > `clouddrive-public` > Settings > Custom Domains 中绑定例如 `cdn.example.com`，完成 DNS/HTTPS 配置，再设置 `wrangler.jsonc` 的 `vars.PUBLIC_BASE_URL` 为 `https://cdn.example.com` 并重新 `npx wrangler deploy`。没有自定义域名时，永久公开直链走 Worker `/p/{id}` 回退路由（消耗 Worker 请求），限时直链和分享页面仍可工作。
9. R2 的 `r2.dev` 公开 URL 不适用于生产，也不要将私有桶接到同一个公开域名。
10. 验证 `GET /api/v1/health`、用户身份、三种分享模式、缓存与上传；**确认 PBKDF2 登录不会超过 Free Worker CPU 配额**，否则不要对公众开放。

注意：Cloudflare 免费计划不保证无费用。默认代码中的 8 GiB 配额不自动追踪 Cloudflare 的账单和所有 R2 临时对象。

## C. 从旧阶段升级已有远程部署

1. 在 Cloudflare Dashboard 或 CLI 确认应用版本与数据库 ID。
2. 停止新上传（可在后台将 `uploads_enabled` 暂时设为 false），并避开繁忙时段。
3. **先备份数据库**，例如：

```powershell
npx wrangler d1 export clouddrive-db --remote --output=clouddrive-backup-before-upgrade.sql
npx wrangler d1 migrations list clouddrive-db --remote
```

   脚本 `scripts\backup-remote-db.bat` 也能执行备份，文件会写入 `backups/` 且被 Git 忽略。**D1 导出不包含 R2 对象内容**，需要另外针对 R2 建立可恢复备份。
4. 确认新增的 `0011_integrity.sql`：加入清理队列与索引，并且**一次性将现存处于 ready 状态的公开发布对象计入空间的 used_bytes**。历史版本部分清理异常可能要求人工核对，不能自动修复所有孤立对象。
5. 应用远程迁移并部署：

```powershell
npx wrangler d1 migrations apply clouddrive-db --remote
npx wrangler deploy
```

6. 比较 `/api/v1/admin/storage`、`/api/v1/admin/reconcile`，检查 pending cleanup jobs、stalled uploads。完整验证再开启上传。
7. **不可将旧版 Worker 直接部署回使用新版 SQL 的数据库而不验证兼容性**。部署回退与数据回退是两件不同的操作。若涉及破坏性回退，请维护窗口内从备份恢复并验证 R2 对象一致性。

## D. GitHub Actions 可选手动部署

项目含 `.github/workflows/deploy.yml`，默认仅 `workflow_dispatch` 手动触发。需要在仓库 Settings > Secrets and variables > Actions 设置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`，部署权限限制在必要的账户/Zone。工作流先运行所有 Node 测试，再用 `cloudflare/wrangler-action@v4` 部署 Worker。**远程数据库迁移不会自动执行**，必须先完成备份和迁移。

## E. 官方文档

- Workers Static Assets：<https://developers.cloudflare.com/workers/static-assets/>
- Workers 限制：<https://developers.cloudflare.com/workers/platform/limits/>
- D1 migrations/backup：<https://developers.cloudflare.com/workers/wrangler/commands/d1/>
- R2 Buckets：<https://developers.cloudflare.com/r2/buckets/create-buckets/>
- R2 公开自定义域名：<https://developers.cloudflare.com/r2/buckets/public-buckets/>
- GitHub Actions：<https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/>
