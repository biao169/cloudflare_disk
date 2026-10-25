# RC8 — 统一分享、链接恢复、权限编辑与公开 CDN

此版本基于 RC7 增量升级，保持原生 HTML + Bootstrap + ES Module、单 Cloudflare Worker、现有 D1 与两只 R2 桶。无需编译前端、无需删除旧数据库、无需重建 Worker、无需修改管理员账号。

## 新增功能

| 功能 | 入口 | 服务端规则 |
|---|---|---|
| 统一创建/管理弹窗 | 文件或文件夹行「分享」；`/shares`「管理 / 获取链接」 | 仅访问属于当前登录用户的分享；即使前端伪造文件 ID 也要检查 ACL |
| 链接重新获取 | 弹窗「重新获取原链接」 | 新/轮换且已加密的令牌：只通过已登录的显式 GET `/link` 解密返回；列表接口不会包含令牌 |
| 历史链接轮换 | 弹窗「轮换并获取新链接」 | 旧分享最初只保存 SHA-256 摘要，不可能恢复原 URL；轮换后旧链接及分享验证会话失效 |
| 分享权限编辑 | 弹窗「编辑权限 / 期限」 | 编辑有效期、下载上限、页面下载开关及密码；不能修改目标和分享类型；修改密码清除已验证的访问会话 |
| 真实失效状态 | `/shares` 及文件行弹窗 | 有效、过期、已撤销、下载额度用尽、目标不可用、创建者被停用或分享权限已撤销 |
| CDN 公开直链 | 管理员的文件行和 `/shares` | 公开 R2 Bucket 直连自定义域名；无域名时退回 `/p/{id}` Worker（不属于 CDN 直连） |
| CDN 缓存清理 | 撤销永久公开发布时（可选） | 如配置 `CDN_ZONE_ID`/`CDN_PURGE_TOKEN`，尝试按单个 URL 调用 Cloudflare Purge API。未配置或失败时返回警告，绝不假称缓存已清理 |

## 一、Cloudflare 网页部署前的运行时设置

进入 Cloudflare Dashboard → Workers & Pages → **现有 `cloudflare-disk` Worker** → Settings → Variables and Secrets。

### `SHARE_LINK_KEY`（建议设置一次）

- 类型 **Secret**，值为独立生成的 **32 字节随机值，用 64 个十六进制字符表示**，例如通过 PowerShell 生成：

```powershell
$b = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($b)
$rng.Dispose()
[BitConverter]::ToString($b).Replace('-', '')
```

- 值只放 Cloudflare Runtime Secret 或 Windows 本地 `.dev.vars`，**绝不放在 `wrangler.jsonc`、GitHub、CI 日志或本文档里**。保管在你的密码管理器中。
- 使用 AES-256-GCM 随机 IV，并以分享 UUID 作为附加认证数据，D1 的 `shares.link_ciphertext` 仅存储密文。SHA-256 摘要仍用于实际访客令牌验证。
- **不要随意更换或删除此密钥**。密钥丢失后，新版已加密链接无法重新取回，访客持有的原链接仍可按其 SHA-256 摘要验证；可以在具有文件权限的前提下轮换产生新链接。需要轮换主密钥时必须先做受控迁移。
- 如果暂时不配置，旧分享、创建新分享以及轮换分享仍可用，但只能在创建/轮换当次复制链接，无法再次解密获取；界面会明确提示。
- 升级前历史分享没有明文令牌，不论是否配置 Secret，都**无法反推出旧链接**。必须点击「轮换链接」，原链接立即失效。

### `BOOTSTRAP_TOKEN`

既有管理员已创建时不用重新初始化；保留既有 Secret，不应在升级时重置它或 D1 数据库。

## 二、R2 公开 CDN 配置（可选，适用于真实公开文件）

1. 先将希望用作 CDN 的子域名所在域添加到 **同一个 Cloudflare 账户**，如 `cdn.example.com`。
2. Dashboard → R2 → `clouddrive-public` → Settings → Custom Domains → Add / Connect Domain，将 `cdn.example.com` 连接到**公开桶**。
3. 等域名状态 **Active** 后，在 GitHub 项目的 `wrangler.jsonc` 中设置（这是公开配置，不是 Secret）：

```jsonc
"vars": {
  "APP_NAME": "CloudDrive",
  "APP_STAGE": "rc8-share-management",
  "PUBLIC_BASE_URL": "https://cdn.example.com"
}
```

4. 提交 GitHub main，由现有 Build Command `npm run build`、Deploy Command `npm run deploy` 自动更新同名 Worker 与现有数据库。
5. **不要**给 `clouddrive-private` 绑定任何 R2 公开域名或启用 `r2.dev`；`clouddrive-public` 的 `r2.dev` 应保持关闭，防止绕开域名缓存/安全策略。
6. 可在 Cloudflare Cache Rules 配置公共对象缓存。默认只对部分格式自动缓存；「缓存所有文件」应仅针对**已经确认公开**的 CDN 子域名，并接受撤销缓存的风险。

公网对象路径为 `https://cdn.example.com/published/<随机UUID>`；不会暴露私有桶的真实对象 Key。已经公开发布的对象能够通过管理界面重新复制同一公开 URL。没有配置 `PUBLIC_BASE_URL` 时，公开 URL 走现有 `/p/<publication_id>` Worker 路由，**不是 R2 CDN 直连**；它每次需要 Worker/D1 访问，消耗 Workers Free 请求额度。

注意：公共 CDN 是实际完全公开的 R2 存储。**它不支持临时有效期、分享密码、撤销即刻全网生效**。这些要求必须用 `/t/` 或 `/s/` 的私有 Worker 授权模式。

### 可选：撤销时自动按 URL 清除 Cloudflare 缓存

如果需要在删除 R2 公开副本后尽力清理 CDN 缓存，可以额外设置：

| 名称 | 类型 | 值 |
|---|---|---|
| `CDN_ZONE_ID` | Worker Runtime Secret 或 Text | CDN 自定义域名所属 Zone ID（32 位十六进制） |
| `CDN_PURGE_TOKEN` | Worker Runtime Secret | 范围限定在该 Zone，含 **Cache Purge** 权限的 Cloudflare API Token |

随后重新部署保存 Secret 的新 Worker 版本。撤销时 Worker 调用 Cloudflare API `POST /client/v4/zones/{zone_id}/purge_cache`，请求 `{"files":["https://cdn.example.com/published/..."]}`。

该功能是**尽力而为**：如果授权不足、API 失败或缓存仍未传播，管理员会看到警告。已有浏览器缓存、他人下载的文件无法收回。禁用 `r2.dev` 避免绕过 CDN 入口。

参考官方说明：
- https://developers.cloudflare.com/r2/buckets/public-buckets/
- https://developers.cloudflare.com/r2/reference/consistency/
- https://developers.cloudflare.com/cache/how-to/purge-cache/

## 三、后端 API

以下 API 均要求有效的 CloudDrive 登录 Cookie，且只允许分享创建者管理自己的分享。请求体默认 JSON，所有敏感响应 `Cache-Control: no-store`。

| Method | Endpoint | 作用 |
|---|---|---|
| GET | `/api/v1/shares?target_type=file&target_id=<UUID>` | 本人某目标的分享列表，不含明文 bearer token；返回精确状态、是否可恢复 |
| GET | `/api/v1/shares/:id` | 本人单个分享详情、失效状态 |
| GET | `/api/v1/shares/:id/link` | 仅当链接处于有效状态且密钥可用时，解密恢复原 URL |
| POST | `/api/v1/shares/:id/rotate` | 轮换 bearer token，原 URL 立即失效（不改变分享 ID），访客密码会话清除 |
| PATCH | `/api/v1/shares/:id` | 修改 `expires_at`、`max_downloads`、页面 `allow_download`、`password_action` |
| DELETE | `/api/v1/shares/:id` | 撤销分享 |
| GET | `/api/v1/publications?file_id=<UUID>` | 超管读取指定文件公开发布状态、CDN URL、缓存清理配置（没有公开 Key 以外的私密数据） |
| DELETE | `/api/v1/publications/:id` | 撤销 R2 公开副本，按需清理 CDN 缓存 |

`PATCH` 示例：

```json
{
  "expires_at": "2026-11-10T18:00:00.000Z",
  "allow_download": true,
  "max_downloads": 25,
  "password_action": "replace",
  "password": "12-or-more-characters"
}
```

- `max_downloads: null` 意味着不限次数，限次下载不允许 Range 断点请求（防止每个分段绕过下载次数）。
- `password_action` 可为 `keep`、`replace`、`clear`，修改密码后删除 `share_access` 里已有验证会话。
- `expires_at: null` 仅表示当前分享页面永久有效。临时直链应保留未来有限有效期；**服务端拒绝**通过 PATCH 让临时直链永久有效。
- 不能 PATCH `target_id`、`type` 或 `created_by`。
- 加密令牌从不会通过分享列表或审计日志输出，仅通过创建/轮换或当前拥有者显式点击恢复获取。

## 四、部署与数据安全

- 自动迁移新增 `migrations/0014_rc8_share_management.sql`，只新增 `shares.link_ciphertext` 和索引。旧分享记录、用户、R2 文件、分享代码摘要均保留。不能从密文为 NULL 的旧记录恢复原 URL。
- 不覆盖当前 Worker 名称 `cloudflare-disk`、D1 的 UUID、公开/私有桶的 Binding，保留其他变量。
- 生产部署前建议备份 D1 及重要 R2 文件。已应用过的 SQL 迁移不应修改，只能追加新迁移。
- RC8 单元/API 集成测试使用 Node + SQLite + 模拟 R2，不等于你的 Cloudflare 账号生产环境实测。
- 由于 Workers Free 的 CPU 限制，涉及 PBKDF2 密码变更的操作需要关注线上性能；不要将管理员/分享密码明文记日志。

## 五、当前边界

1. 旧链接不可能从 SHA-256 摘要还原，**只能轮换**。轮换动作有确认，旧链接立即失效。
2. 缺少 `SHARE_LINK_KEY` 时只支持轮换，不支持新链接长期可恢复；密钥误改造成历史密文不可解密，但不会自动泄漏链接。
3. 公共 CDN 直链不能承诺「撤销即刻所有缓存消失」；只对可信公共文件使用。
4. 下载次数只统计受限制分享的正式 GET，不统计预览或 HEAD；不实现复杂的跨 CDN 公共访问统计。
5. 分享模式及目标创建后不可直接编辑；如需由公开改成私密，请撤销公开副本后重新发布私密分享。
