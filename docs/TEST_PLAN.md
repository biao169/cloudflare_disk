# 第十二阶段：上线前验收清单

## 自动化验证（当前执行环境）

- [x] Node `npm run check`：后端与主要前端 JS 语法校验。
- [x] 44 项 Node 单元/路由测试。
- [x] 9 项真实 SQLite SQL + 模拟 R2 的请求级集成测试（账号、权限、普通上传、Range、分享密码/撤销/过期、公开发布、9 MiB Multipart、回收站最后引用、R2 故障恢复、容量预留）。
- [x] 11 个 SQL 文件在 Node SQLite 测试环境创建和执行。
- [ ] **Windows Wrangler/Miniflare 完整运行及浏览器点击回归：当前执行环境未验证。**
- [ ] **Cloudflare Free 真实 Worker CPU 和 R2/D1 线上验证：需要账户授权。**
- [ ] 公网 CDN 缓存与撤销传播验证。

## Windows 必测步骤

每项至少以**管理员、编辑成员、只读成员**分别测试。准备多个空间、至少两位用户，一个 1 KB 文本、一个 5 MB 图片、一个 9 MB PDF、一个 150 MB MP4 和一个 1 GB 可选压力文件。

- [ ] **安装和重启**：`npm install`、`npm run db:migrate:local`、`npm run dev`；页面 `/login` 首次初始化；刷新/重启后用户、文件仍存在。
- [ ] **认证**：正确密码登录、错误密码、超时登出、停用用户后旧 cookie 失效、修改密码后旧会话失效、Origin 伪造返回 403。
- [ ] **权限**：不同用户无法用猜测 UUID 读取/修改文件；viewer 无法上传或创建文件夹；空间移除成员后原请求与上传会话都被拒绝。
- [ ] **文件夹**：根目录、嵌套创建、重命名、移动、防循环，重复名称，跨空间移动禁止或有明确信息。
- [ ] **普通上传**：1 KB、8 MiB 内文件上传；重复文件名、模拟断网、文件与 D1 账本一致；多文件操作不会误覆盖。
- [ ] **Multipart**：上传 150 MB，查看进度，点击暂停/继续、刷新后重新选择文件续传、重复合并、取消上传、超过容量拒绝、24 h 过期清理。
- [ ] **文件下载**：原始字节相同；HEAD、Range `bytes=0-1023` 的 206 响应；非法 Range 的 416；无权限读取的 401/404。
- [ ] **在线预览**：有效的 JPEG、PNG、GIF、WebP、MP4、WebM、PDF；图片切换/缩放；视频拖动；伪造 PDF 头返回 415；移动端 375×812、390×844、412×915。
- [ ] **临时直链**：创建、无登录下载、到期、撤销后拒绝、Range 响应、非文件分享拒绝。
- [ ] **分享页**：密码错误、正确、验证 Cookie 作用域、图片视频 PDF 预览、文件夹子路径只能在被分享根目录以内、撤销后浏览器刷新失败。
- [ ] **永久公开**：私人 R2 中的源对象不能直接被公网访问；公开副本 URL 可访问；发布增加配额使用，撤销扣减配额；清理 Cloudflare 缓存，并明确可能的缓存延迟。
- [ ] **回收站**：软删除/恢复，默认或自定义保留期限、目录嵌套恢复、文件同名冲突、最后一个共享对象引用消失后才删除物理 R2。
- [ ] **故障恢复**：模拟 R2 DELETE 失败后产生 `storage_cleanup_jobs`，Cron 再次处理并核对账单计数；数据库连接丢失返回 503；检查 `failed`/`verifying` 上传状态。
- [ ] **配额**：多空间同时上传时全局剩余额度不被轻易突破；公开副本单独消耗物理容量；回收站仍占容量；管理页统计与 R2 实测对象核对。
- [ ] **安全**：Cookies Secure/HttpOnly/SameSite、CSP、XSS 文件名、禁用非法 MIME 预览、强制 HTTPS、无公开私有桶、环境变量不泄露、上传 413 返回一致。
- [ ] **性能/免费限制**：在 Cloudflare Free 远程实际测试登录 PBKDF2、9MB Multipart 和 150MB 视频 Range 的 Worker CPU 与调用次数，检查 D1 免费读写行额度。

## 命令行 HTTP 示例（需先登录获得 Cookie）

```powershell
curl.exe -i http://localhost:8787/api/v1/health
curl.exe -i http://localhost:8787/api/v1/auth/me
# 必须按需测试私有文件的 HEAD / Range，绝不要在真实数据上运行危险的删除测试
```

## 验收判定

**所有阻断性安全用例必须通过** 才能标为正式生产可用。自动化的 53 项测试只能作为回归基础，不能替代真实 Windows/Cloudflare 的部署前测试。`docs/SECURITY.md` 标注了仍然存在的风险。

## 网页版一键部署专项验证（RC2）

- [ ] 公开 GitHub/GitLab 仓库根目录具备 `wrangler.jsonc`、`package.json`、`migrations/`、`worker/`、`public/` 和 `.dev.vars.example`。
- [ ] 官方 Deploy to Cloudflare 页面显示正确的 D1 与两个 R2 Bucket；Build Command 为空；Deploy Command 为 `npm run deploy`。
- [ ] 部署流水线按顺序执行 `wrangler d1 migrations apply DB --remote` 和 `wrangler deploy`，没有使用占位 UUID 连接错误的数据库。
- [ ] `BOOTSTRAP_TOKEN` 使用真实的长随机字符串作为 Worker Secret，且占位值初始化会被拒绝。
- [ ] 新建管理员后注销/轮换一次性初始化密钥，确认无法重复创建超级管理员。
- [ ] **没有 R2 CDN 域名** 时创建公开发布链接 `/p/{id}`，分别验证完整 GET、HEAD、206 Range、撤销后 404，且未公开私有 R2 Bucket。
- [ ] 有 CDN 域名时新发布链接返回 HTTPS CDN 地址，并检查删除后的缓存问题。
- [ ] 查看 Worker 免费计划 CPU 指标并测试注册管理员、管理员登录、修改密码、分享密码校验的实际表现；出现 1102 时停止公网启用。
