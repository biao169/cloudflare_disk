# RC14.7 — Microsoft OAuth 回调错误诊断与修复

## 故障

此前登录回调出现：

```json
{"success":false,"error":{"code":"OAUTH_CALLBACK_ERROR","message":"OAUTH_FAILED"}}
```

旧版 `finishOAuth()` 使用 `if (!state || !code || p.has('error')) throw Error('OAUTH_FAILED')`，将微软授权拒绝、同意不足、缺少授权码、缺少 state 全部混在一起，丢失微软返回的 `error` / `error_description` 的诊断信息。**仅凭这条旧错误无法确定是账户类型、权限还是回调配置问题。**

## 本次修复

- 识别微软 `error` 以及 `error_description` 中的 `AADSTS#####` 编号，对应常见错误给出中文处理建议；严格禁止回显完整微软描述（可能含账户或租户信息）。
- 将“缺少 state”、“缺少 code”、“10 分钟授权会话过期”与“微软拒绝授权”区分开。
- Token 交换失败可显示安全的微软错误编号，区分 Client Secret 无效、权限不同意和超时。
- OAuth 回调浏览器 **303 返回 OneDrive 工具页面**，显示错误类别和 AADSTS 编号，而不是显示 JSON 错误或泄露 code/state。原有成功跳转保留。
- 系统设置内显示此次授权将使用的 **精确 Web 回调 URI**，并逐项更新配置教程。
- 新增可选的 `MS_REDIRECT_URI`，用于统一有多个域名的 Worker 的 OAuth 回调。与当前访问域名不同时阻止发起授权，避免在登录后丢失 Cookie。
- 保留 D1 的 OAuth State 和 PKCE 校验、管理员权限控制、AES-GCM Token 加密。**无需迁移或更换 MS_TOKEN_KEY。**

## 逐项检查 Microsoft 应用

1. 打开 <https://entra.microsoft.com/> → Entra ID → 应用注册 → 你的应用。
2. 「概述」：`MS_CLIENT_ID` 对应 **应用程序(客户端) ID**（GUID），不是租户 ID。
3. 「身份验证」→ Web：复制 CloudDrive **系统设置 → OneDrive** 中显示的 **完整回调 URI**，原样添加到 Microsoft Entra。一般为：
   `https://实际的CloudDrive域名/api/v1/admin/onedrive/oauth/callback`
   必须包含 HTTPS，域名和路径一致，不能多一个 `/`，不能用 `workers.dev` 与自定义域名混用。
4. 「支持的账户类型」：个人 OneDrive 的 Outlook/Hotmail/Live 账号必须选择包含**个人 Microsoft 账户**的类型；企业/学校 OneDrive 要允许对应租户。
5. 「API 权限」：检查 Microsoft Graph 委托权限 `Files.ReadWrite` 和 `User.Read`，请求中还包含 `offline_access` 以取得刷新令牌。组织账号可能需要租户管理员同意。
6. 「证书和密码」：`MS_CLIENT_SECRET` 填写客户端密码的 **Value**，不是 Secret ID。确认没有过期。
7. Cloudflare 的 Worker 运行时 Secrets：确保 `MS_TOKEN_KEY` 是原来的有效 32 字节加密密钥，**不要因为 OAuth 错误而更换它**。
8. `MS_TENANT` 通常设 `common`（组织和个人账户均可向统一入口登录，最终仍取决于应用支持的账户类型）；仅个人 OneDrive 时可使用 `consumers`。企业单租户应用使用相应 Tenant ID。
9. 重新部署 Worker，使用同一浏览器、同一域名重新登录 CloudDrive 超级管理员账号，从系统设置重新点击“连接 Microsoft 账户”，并在十分钟内完成授权。不要重复打开旧的回调链接。

## 可选：显式固定 OAuth 回调域名

如果 Worker 同时绑定 `workers.dev` 和自定义域名，建议设置普通运行时变量：

```text
MS_REDIRECT_URI=https://你的正式CloudDrive域名/api/v1/admin/onedrive/oauth/callback
```

然后：

- 在 Microsoft Entra Web 重定向 URI 中添加这个精确地址。
- 只从 `https://你的正式CloudDrive域名` 进入系统并发起授权，不要在预览域名启动授权。
- `MS_REDIRECT_URI` **不含客户端密钥**，可用 Text 类型。建议保持不变，否则发起授权和换取令牌的回调地址可能不一致。
- 如果仅使用单一域名，不需要配置这个变量；系统将自动根据当前请求生成回调 URI。

## 新的错误提示与建议

| 可见错误 | 可能的原因 | 处理建议 |
|---|---|---|
| `MICROSOFT_CONSENT_DENIED` | 用户取消、拒绝授权 | 重试并同意所需权限 |
| `MICROSOFT_ADMIN_CONSENT_REQUIRED` / `AADSTS65001` | 管理员同意或权限不足 | 检查 Graph 委托权限和组织同意策略 |
| `MICROSOFT_ACCOUNT_TYPE_MISMATCH` / `AADSTS50020` | 应用不允许当前 Microsoft 账号 | 修改支持的账户类型、MS_TENANT |
| `MICROSOFT_REDIRECT_URI_MISMATCH` / `AADSTS50011` | 请求回调与 Entra 不一致 | 将系统设置显示的实际 URL 原样注册为 Web 回调 |
| `MICROSOFT_APP_NOT_FOUND` / `AADSTS700016` | 客户端 ID、租户不匹配 | 检查应用和 MS_CLIENT_ID |
| `MICROSOFT_INVALID_CLIENT_SECRET` / `AADSTS7000215` | 填入 Secret ID、密码错误或过期 | 在 Entra 新建 Client Secret 并填写 Value |
| `OAUTH_STATE_INVALID` | 授权耗时超过 10 分钟、重复使用或者登录账号改变 | 重新发起授权，尽快完成 |
| `OAUTH_SESSION_LOST` | 域名变化、浏览器丢失管理员会话 Cookie | 保持同一个 HTTPS 域名、浏览器重新登录 |
| `MS_REDIRECT_ORIGIN_MISMATCH` | 从非指定域名打开网站 | 从 `MS_REDIRECT_URI` 的域名进入 |
| `MICROSOFT_TOKEN_EXCHANGE_FAILED` | 微软授权码不能兑换令牌 | 检查 Secret、授权是否过期、回调和 PKCE |

**注意：** Microsoft 对回调地址的某些拒绝（例如 AADSTS50011）会直接在 Microsoft 登录页面展示，可能不会重定向回 CloudDrive；这种情况要从微软登录页面抄写**错误编号**，而不是复制包含授权码的完整链接。

## 安全说明

不要在聊天、工单和日志中公开 `MS_CLIENT_SECRET`、`MS_TOKEN_KEY`、Microsoft `code`、`state`、Access Token、Refresh Token 或完整回调 URL。需要排错时只提供脱敏错误类别和 `AADSTS` 编号。

此补丁只改变 OAuth 诊断、回调 URI 一致性检查以及 UI 教程。部署前建议备份源码，验证 `npm run build`。**目前未连接你的真实 Microsoft 账户，因此无法仅凭旧版 JSON 断言是哪一种 Microsoft 错误。**
