# RC14.7 — Microsoft OAuth 配置检测及 `MICROSOFT_TOKEN_KEY_MISSING` 修复

此修复无需新增 D1 迁移、不更换已保存的 Share Link Key，也不会重新生成原有 Token 加密密钥。

## 一、报错原因

旧版 `worker/services/onedrive-oauth.js` 使用单一条件检查：`MS_TOKEN_KEY` 不存在或者不是 **恰好 64 位十六进制字符**，都会返回相同的 `MICROSOFT_TOKEN_KEY_MISSING`。因此当用户已经填写某个值、但格式不正确或设置在错误的部署环境中时，也会收到“缺少密钥”的提示；原后台配置状态还未检查 `MS_CLIENT_SECRET` 和密钥格式。

新版后端区分 `MICROSOFT_TOKEN_KEY_MISSING`（当前 Worker 运行时未收到变量）、`MICROSOFT_TOKEN_KEY_INVALID`（已收到但不符合要求）、`MICROSOFT_TOKEN_KEY_CONFLICT`（两个不同的名字同时设置且内容不同）。配置状态接口为超级管理员返回逐项结果，**绝不返回真实 Secret**。

## 二、微软与 Cloudflare 配置一览

| Worker 变量 | 来源 | 格式/特别说明 |
|---|---|---|
| `MS_CLIENT_ID` | Microsoft Entra → 应用注册 → 概述 → 应用程序(客户端) ID | GUID，不是租户 ID |
| `MS_CLIENT_SECRET` | Microsoft Entra → 应用注册 → 证书和密码 → 客户端密码 → **值（Value）** | 不是机密 ID（Secret ID） |
| `MS_TOKEN_KEY` | **自行生成**的 32 字节随机密钥 | 64 位十六进制字符（推荐）或 32 字节 Base64；绝不能填微软客户端密码 |
| `MS_TENANT`（可选） | 根据 Microsoft 账号类型 | 默认 `common` |

Windows PowerShell 生成密钥（只需要在初次配置时执行一次）：

```powershell
$b = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($b); [BitConverter]::ToString($b).Replace('-', '').ToLowerInvariant() }
finally { $rng.Dispose() }
```

将结果**仅作为 Value**填入名为 `MS_TOKEN_KEY` 的 Secret，不要复制 `MS_TOKEN_KEY=` 前缀、引号或占位符。保密并妥善备份；一旦已经授权了 Microsoft 账号，不可直接重新生成并覆盖旧密钥，否则旧令牌解密会失败。

## 三、如何排查和验证

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages → **正在为网站提供请求的那个 Worker** → Settings → Variables and Secrets。
2. 确认变量名准确且值存在于**运行时**环境（不是仅存在于 GitHub、Build 环境变量、另一个 Worker 或 Preview 环境）。`MS_CLIENT_SECRET` 和 `MS_TOKEN_KEY` 建议使用 **Secret**。
3. 保存更改后重新部署该 Worker；确认访问的域名指向它。若设置了生产/预览多个环境，两者须分别配置。
4. 管理员打开 `/settings` → 站点设置 → Microsoft OneDrive 账户，点击 **重新检查配置**。新页面会逐项报告“有效 / 未读取到 / 格式错误 / 配置冲突”，不泄露密钥值。
5. 三个必填项全部显示有效后再点击连接账户。

### 兼容名称

新版临时兼容 `MICROSOFT_TOKEN_KEY` 作为别名，但推荐始终使用 `MS_TOKEN_KEY`。如果两个变量同时存在但值不同，会拒绝继续授权，避免静默切换加密密钥。迁移命名时，必须保留**相同的密钥值**。

### 常见错误

- `MICROSOFT_CLIENT_ID_MISSING` / `MICROSOFT_CLIENT_ID_INVALID`：客户端 ID 缺失 / 不是标准 GUID。
- `MICROSOFT_CLIENT_SECRET_MISSING`：未读取到客户端密码 Value。
- `MICROSOFT_TOKEN_KEY_MISSING`：Worker 运行时没有接收到变量。
- `MICROSOFT_TOKEN_KEY_INVALID`：变量存在但不是合规的 32 字节密钥编码。
- `MICROSOFT_TOKEN_KEY_CONFLICT`：`MS_TOKEN_KEY` 与 `MICROSOFT_TOKEN_KEY` 两者不一致。

### 注意

配置检测通过不代表 Microsoft OAuth 授权、Graph 文件访问或实际下载成功；这些仍需在已部署环境中测试。Token 相关值不会回显给浏览器或日志，不应该在聊天记录中粘贴任何真实 Secret。
