# RC14.12 Hotfix 本地验证报告

基线：RC14.12-OneDrive-Sync-Operations-Full.zip（本次在源码内原地增量修复，不重建数据库）。

## 验证命令及结果

- `npm run build`：成功。
- `npm run check:migrations`：成功；无新增迁移文件。
- `npm run check`：所有 JavaScript 语法检查通过。
- `npm test`：147 / 147 项通过。
- `npm run test:integration`：134 / 134 项通过。
- `tests/rc5-deploy.test.js`：模拟远程部署时两次 `deploy` 都带 `--keep-vars`，临时配置 `keep_vars` 为 true。
- `tests/integration/onedrive-download-fix.test.js`：模拟 Graph 返回临时地址、仅 302 `/content`、直接流式内容、403/401/429、过期回调异常、恶意重定向、Graph `$select` 不兼容回退与管理员诊断权限。
- `tests/rc14-12-folder-activation.test.js`：验证文件夹双击正常导航、操作按钮和复选框不会触发跳转、文件和 OneDrive 多个视图均接入。

## 安全检查

- 授权令牌只向 `graph.microsoft.com` 发送；`redirect: manual` 禁止将 Graph Bearer Header 自动传给临时下载主机。
- 临时下载目标采用现有的 Microsoft 下载域名允许列表校验；不接受攻击者提供的任意重定向 URL。
- 管理员诊断仅返回安全状态代码、服务端 HTTP 状态和处理建议，不返回原始下载链接或访问令牌。
- 下载失败不增加成功下载跳转计数；已有密码、到期时间、暂停状态及子项权限拦截继续生效。
- D1 和 R2 原数据、分享 ID 与 Microsoft OAuth 密文均不变。

## 尚未验证

- 没有连接用户的真实 Microsoft OneDrive 账户或 Cloudflare 生产 Worker，不能保证每个源文件的下载均已恢复。
- 未进行生产网络大文件、视频 Range、浏览器双击动作的真实设备端到端验收（本次覆盖了 JS 事件与后台集成测试）。
- 若上线仍失败，应查看管理员“诊断下载”的错误代码、对应 Microsoft HTTP 状态及 Worker 日志；不要共享含 Token 的 URL 或密钥。
