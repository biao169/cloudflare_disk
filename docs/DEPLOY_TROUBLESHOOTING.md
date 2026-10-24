# CloudDrive Cloudflare 资源自动配置与部署诊断（RC3）

## 1. 如何判断一段 Cloudflare 日志是否报错？

出现 `✨ Success! Uploaded 23 files`、`PRIVATE_BUCKET provisioned`、`PUBLIC_BUCKET provisioned`、`Your Worker has access to ...` 都属于部署过程中的**正常信息**，并不意味着已经完成 Worker 发布。必须继续看到最终的 `Deployed` / `Published` / 失败退出状态。如果只粘贴到 Binding 列表末尾，无法确定最终失败点。

`PUBLIC_BASE_URL ("")` 是可接受的配置：公开文件可以从 `/p/{publication_id}` 通过 Worker 下载，代价是消耗 Worker 请求额度。

## 2. 自动部署命令与 D1 自动迁移

首次一键部署请在 Cloudflare 控制台的 Worker → Settings → Builds 检查：

- Git 仓库：`biao169/cloudflare_disk`（或你部署按钮生成的 fork）
- Build Command：**留空**；前端无需编译
- Deploy Command：**`npm run deploy`**（不要仅使用 `npx wrangler deploy`）

`npm run deploy` 执行 `scripts/deploy-cloudflare.mjs`：

- 如果已有远程 D1 数据库且 `wrangler d1 migrations list DB --remote` 可正常运行：先应用迁移再部署新 Worker（升级顺序）。
- 如果第一次资源尚未可访问：先 `wrangler deploy` 触发自动创建 D1/R2，再执行 `wrangler d1 migrations apply DB --remote`（首次部署顺序）。在迁移完成之前，Worker 可能已经存在，但业务 API 尚不可用。
- 如果数据库升级时探测失败：**不要强行继续部署**。先修复 Cloudflare API 网络、权限或 D1 绑定，备份后用 `npm run deploy:upgrade`。

部署日志缺少任何迁移记录时，很可能 Cloudflare Build 的 Deploy Command 仍是默认的 `npx wrangler deploy`。修改后需触发 **Retry / Redeploy**。

本项目新版 `wrangler.jsonc` 不再包含假的 D1 ID；Cloudflare 自动资源配置需要 Wrangler 4.45.0+。已有实例请核对新版本绑定的 D1 是否是原数据库。

## 3. Worker URL 快速检查

打开：`https://你的-worker.你的子域名.workers.dev/api/v1/health/ready`

状态码 / code：

- `503 BINDING_MISSING`：检查 DB、R2、ASSETS 的 Binding 是否存在。配置对象无法替代真实资源。
- `503 D1_MIGRATIONS_REQUIRED`：绑定存在，但必须执行 `wrangler d1 migrations apply DB --remote`，**不要手动删除 D1 或重建有数据的数据库**。
- `503 D1_QUERY_FAILED`：数据库存在但查询失败。检查 Worker Logs、绑定、数据库权限与状态。
- `503 BOOTSTRAP_SECRET_REQUIRED`：去 Settings → Variables and Secrets 添加 `BOOTSTRAP_TOKEN`，至少 32 字符且不是示例占位符。
- `503 ADMIN_SETUP_REQUIRED`：准备完毕，去 `/login` 创建第一个管理员。
- `200 READY`：基础表、必要 Binding 和超级管理员均存在；不等于完整浏览器验收。

对于空数据库但尚未绑定资源的情况，`/api/v1/health` 仍可能返回 200，它仅用于 Worker 运行检查，不负责检测是否可用。

## 4. Windows 本地 / CLI 补救（已登录 Cloudflare 才能操作）

先确认已连接正确账户和 Worker，再在项目根目录执行：

```powershell
npx wrangler whoami
npx wrangler d1 migrations list DB --remote
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

执行远程迁移之前，若数据库已有业务数据，必须先做备份并检查新增 SQL 的兼容性。以上命令不会自动修改另一个账户；目标由当前 Wrangler 登录和配置决定。

如果 GitHub CLI/PowerShell 需要代理，建议只对当前终端临时配置 `HTTP_PROXY`、`HTTPS_PROXY`；**不要为了发布 CloudDrive 修改 Windows 或 Git 的全局代理设置**。部署完后恢复原来的环境变量。

## 5. 安全验收

- `clouddrive-private` Bucket 的所有公开访问入口均应关闭。
- `BOOTSTRAP_TOKEN` 不能写在 `wrangler.jsonc`、`.github/workflows/` 或公开源码中；后台 Secret 配置完成后再初始化。
- 创建管理员后，应移除或轮换首次初始化 Secret。
- 真实 Workers Free 单次 CPU 限制可能影响 100,000 次 PBKDF2 登录验证；需要在线测量并保留密码安全性。
- D1/R2 一致性、批量删除、上传续传、视频 Range 和分享过期都需要在真实浏览器上验证。
