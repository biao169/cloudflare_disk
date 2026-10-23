# 密码学检查及一键部署说明（2026-10-23）

## 官方结论

Cloudflare Workers 的 Web Crypto 支持 PBKDF2 和 SHA-256/384/512；**没有官方通用的“密码哈希最多 128 bits”规则**。免费版的 **128 MB 内存** 与 128-bit 盐、256-bit 密码哈希不是一回事。官方资料：

- <https://developers.cloudflare.com/workers/runtime-apis/web-crypto/>
- <https://developers.cloudflare.com/workers/platform/limits/>
- <https://developers.cloudflare.com/workers/platform/deploy-buttons/>

## 本仓库审查结果

`worker/services/auth.js`：

- 登录密码现在按用户要求限制为 **6–128 个 Unicode 字符（按代码点计数）**，不再设置额外的 256 字节上限；与分享链接访问密码的独立长度限制无关。
- `PBKDF2-SHA256`，100000 iterations；盐来自 `crypto.getRandomValues(new Uint8Array(16))`（128 bits）；`crypto.subtle.deriveBits(..., 256)`（256-bit hash）。
- 登录密码与分享密码采用 PBKDF2-SHA256；分享链接密码仍保持原来的最短 12 字符规则。**哈希算法、盐长度和迭代次数均未修改，旧账号可以继续登录**。
- 登录令牌使用随机字节，D1 中保存 SHA-256 摘要；初始化令牌须为加密 Secret，拒绝示例占位符。
- **CPU 风险未消除**：Workers Free 每次请求 10 ms CPU 额度。Web Crypto 虽比纯 JS 运算效率高，仍要在 Cloudflare 免费账户实际监控 1102、CPU 指标。未真实执行线上测试。

## 自动部署过程

1. ZIP 解压后把项目根目录的文件上传到公开 GitHub/GitLab 仓库。
2. 双击 `deploy-link.html` 填入该仓库地址，自动打开官方部署网页。
3. `wrangler.jsonc` 中的 D1/R2 Bindings 会被官方部署按钮自动配置，`package.json` 的 Deploy Script 执行 `npm run db:migrate:remote && npm run deploy:code`。
4. Worker Secret `BOOTSTRAP_TOKEN` 首次填写或部署后从 Cloudflare 仪表板添加；然后访问 `/login` 初始化管理员。
5. 无 R2 自定义域名时，公开直链使用 `/p/:id` 通过 Worker 读取 `PUBLIC_BUCKET`；这是直接响应文件内容，不是分享页，可立即撤销但占用 Worker 请求。
6. 在 Workers Free 上完成安全和 CPU 验收，再用于真实多人数据。

## 维护限制

- Deployment Button 仅支持可访问的**公开** GitHub/GitLab 仓库；文档中的仓库 URL 都是替换占位符，不能直接使用。
- 新实例的 SQL 自动初始化与已有数据库的自动升级风险不同。现有生产 D1 必须备份、核对迁移后再部署。
- 公开桶不会因 Worker 回退路由而自动开放 R2 匿名访问；只有主动开启 R2 公共域名才会直接暴露对象路径。
