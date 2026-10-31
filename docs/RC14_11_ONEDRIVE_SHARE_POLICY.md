# RC14.11 — OneDrive 分享权限与统计管理

此版本在 RC14.10 上新增单文件、文件夹和跨目录合集分享的 CloudDrive 权限层；**不修改 Microsoft OAuth、原有文件 ID、R2 存储或 `/s/odf_*` `/r/odf_*` `/s/odg_*` 地址**。

## 升级

1. 备份 Cloudflare D1（建议另行备份 R2）；现有 OAuth 密钥和 D1 资源绑定保持不变。
2. 将本版本源码或增量补丁部署到当前 Worker 项目，确认之前的 `0027`–`0029` 已执行。
3. 运行 `npm run build`，然后 `npm run db:migrate:remote` 应用 `migrations/0030_rc14_11_onedrive_share_controls.sql`，最后 `npm run deploy`。如果你的 `npm run deploy` 已执行迁移，先检查部署脚本和迁移状态，不要重复部署命令来解决报错。
4. 以超级管理员身份打开 `/onedrive`，进入“已发布直链”“文件夹与合集分享”或“权限与统计”选项卡，点击“权限与统计”进行配置。
5. 使用无痕浏览器验证：公开、密码、已暂停、有效期和登录限制的分享页、下载和预览行为；核对时间按浏览器所在时区展示。

**新增 Secret：默认不需要。** 密码解锁会话可复用稳定的 `MS_TOKEN_KEY` / `MICROSOFT_TOKEN_KEY`，也可单独配置 `ONEDRIVE_SHARE_SESSION_KEY`（至少 32 字符的随机 Secret）；只有当前站点已配置 `SHARE_LINK_KEY` 时，也可作为后备。不要更换原有 Microsoft Token Key，避免无法解密已授权账户。若更换解锁签名密钥，旧访客解锁 Cookie 会失效，需要重新输入密码。

## 管理后台功能

| 选项 | 默认行为 | 说明 |
|---|---|---|
| 分享暂停 | 关闭 | 暂停后页面元数据、封面、预览和下载都拒绝访问；恢复使用相同固定 ID |
| 访问范围 | 持有链接的访客 | 亦可设为仅 CloudDrive 已登录用户；不是要求登录 Microsoft |
| 密码 | 不设置 | 独立于 CloudDrive 账号密码，6–128 字符，PBKDF2-SHA256、每条记录独立随机盐、160000 次迭代 |
| 有效期 | 不限期 | 输入浏览器本地时间、提交时转换 UTC；过期后可设为新的未来日期恢复 |
| 页面浏览次数 | 不限制 | 仅计算成功读取公开分享元数据的 GET；不是 UV，不计 HEAD，也不等同于下载次数 |
| 下载跳转次数 | 不限制 | 仅计算 `/r/odf_*` 成功发出 302 下载跳转；严格约束新的跳转，不保证微软端实际完成下载 |
| 分享页显示直链按钮 | 开启 | 仅隐藏单文件展示页的复制直链按钮；合集目录仍提供必要的下载按钮，且无法撤销此前复制出去的 `/r/odf_*` URL |
| 权限统计 | 聚合统计 | 单个分享累计浏览、下载跳转、最近 30 天按 UTC 日期汇总；不记录明文 IP、密码或微软令牌 |

权限修改通过 `PATCH /api/v1/admin/onedrive/shares/{id}/policy` 保存；`GET /api/v1/admin/onedrive/shares/summary` 和 `GET /api/v1/admin/onedrive/shares/{id}/stats` 返回统计。上述管理端点仅允许超级管理员访问。

分享密码通过 `POST /api/v1/public/onedrive/unlock` 验证，成功返回 HttpOnly、SameSite=Lax 的短期签名 Cookie（HTTPS 部署时添加 Secure），签名绑定具体分享 ID 和策略版本。错误密码按分享+访客的 15 分钟窗口最多尝试 8 次；如发生更改密码、暂停、权限修改，先前解锁会话立即失效。前端不在 localStorage 保存密码。

## 继承与撤销

- 文件夹/合集使用 `odg_*` 权限；归属该合集的 `odf_*` 文件**直接 URL、预览、封面**都继承父级访问约束。为了避免混乱，不允许单独修改组内文件的分享权限。
- 合集撤销后原来的组及其专属文件直链一起失效；单文件撤销不可通过“取消暂停”恢复，需重新创建。
- 下载上限在 D1 数据库中使用条件更新，并通过 SQLite trigger 原子增加合集的计数。拒绝请求不扣减计数。
- UTC 过期时间每次请求检查；无需后台定时任务才能生效。Cron 会批量清理过期密码尝试记录及 90 天前的按日统计，保留累计计数和分享记录。

## 关键限制与安全风险

1. `/r/odf_*` 当前使用管理员 OAuth 获取 Microsoft Graph 临时下载 URL，并通过 302 交给访问者。**即使暂停 CloudDrive 分享或达到下载上限，已经发放的微软临时 URL 仍可能暂时有效**。严格需要即时撤销、按字节限额或验证下载完成的场景，应采用受控的分块代理下载并配合源侧权限撤销；本版本未提供这种强保证。
2. “限制页面浏览次数”并不能代替“限制下载次数”。对于合集，浏览次数统计指合集页面，子文件的浏览次数单独记录；合集文件的新下载均共享父合集的下载上限。
3. 对外公布的直链实际上使管理员明确发布的文件允许持有者在 CloudDrive 规则下访问，即使 OneDrive 文件原来是私有的。请勿把敏感资料发布到该机制。
4. Microsoft Graph 上游请求限流、账户授权失效或 OneDrive 文件删除仍可能导致分享不可用。管理员已发布文件的安全保护默认启用，但要在真实 Microsoft 账号和 Cloudflare 环境进行端到端验证。
5. **Microsoft 于 2026-10-08 宣布：自 2027-04-01 起 SharePoint Online / OneDrive 的部分预授权 `tempauth` URL 逐步退役。** 企业 OneDrive 的下载、预览与缩略图应提前适配 Graph `contentStream` 或基于正确受众的 Entra 令牌流，不应长期依赖无身份凭证的下载 URL。详见 https://devblogs.microsoft.com/microsoft365dev/pre-authenticated-tempauth-urls-are-retiring-move-to-microsoft-entra-id-tokens-before-april-1-2027/ 。个人 OneDrive 和企业 SharePoint 的具体行为需分别测试。

## 主要 API

```text
GET   /api/v1/admin/onedrive/shares
GET   /api/v1/admin/onedrive/shares/summary
GET   /api/v1/admin/onedrive/shares/{odf_or_odg_id}/policy
PATCH /api/v1/admin/onedrive/shares/{odf_or_odg_id}/policy
GET   /api/v1/admin/onedrive/shares/{odf_or_odg_id}/stats
POST  /api/v1/public/onedrive/unlock
GET   /api/v1/public/onedrive/{odf_id}
GET   /api/v1/public/onedrive/{odf_id}/preview
GET   /api/v1/public/onedrive/{odf_id}/cover
GET   /api/v1/public/onedrive/groups/{odg_id}
GET   /r/{odf_id}
```

## 测试

`npm run build` 包括语法、迁移安全扫描、单元与 SQLite 模拟 D1/R2 集成测试。上线前建议从无痕浏览器验证密码解锁 Cookie 传递、移动端适配、Microsoft Graph 429/403/404、SharePoint 企业账号和个人 OneDrive 的真实下载。
