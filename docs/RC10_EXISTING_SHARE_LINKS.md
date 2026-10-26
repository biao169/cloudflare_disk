# RC10 — 再次点击「分享」：查看原链接并编辑属性

## 目标与实现

在 `/files`、`/recent` 的文件/文件夹上点击 **分享 / 管理**，或在 `/shares` 点击 **查看原链接 / 编辑**：

1. **优先展示当前账号对该文件已经创建的分享**，默认不再鼓励重复创建。
2. 对于保存了加密令牌、且 Worker 配有正确 `SHARE_LINK_KEY` 的记录，自动取回最新的一条可恢复原链接。其他记录点击「查看 / 复制原链接」即可取回；URL 输入框支持复制。
3. 「编辑期限 / 密码 / 权限」内直接修改分享属性：有效期、下载上限、分享页面是否允许下载、访问密码。成功修改后**不改变 URL，也不会创建新分享记录**。
4. 过期或下载次数耗尽的分享仍允许**所有者取回原链接**；调整有效期或下载次数后，旧地址可以继续使用。撤销、权限失效、源文件不可用时不能取回。
5. 永久公开副本由管理员在同一个弹窗查看、复制和撤销。公开副本的失效受 CDN/浏览器缓存影响，与私有分享不同。
6. 「新建分享」默认在已有记录时收起，只有明确点击「创建另一条分享链接」才打开。**不同分享模式要新建链接**，不能把已有临时直链原地址无损改成分享页。

## 真实原始链接与安全限制

- **新建/轮换的可恢复链接**：Worker Secret `SHARE_LINK_KEY` 必须保留原值，格式为 64 个十六进制字符（32 字节）。链接令牌由 AES-GCM 加密保存，D1 仍存 SHA-256 摘要以验证访客链接。
- **RC8/RC9 已加密的链接**：配置仍在且密钥没有变，可以取回原令牌；但旧版未保存分享创建时的域名，所以在切换域名后只能恢复**同一个令牌路径**，不一定能还原原始域名。
- **RC10 新链接**：在 D1 `shares.link_origin` 保存创建时的地址 origin，原链接可以连同原始域名一起恢复。如果原域名已停用，重获原 URL 不代表它仍可访问。
- **RC7 或未配置 Secret 时的旧分享**：D1 仅有 SHA-256 哈希，无法还原原始随机令牌。页面会明确提示并要求用户确认「轮换链接」。**轮换会使已经发给别人的旧地址失效。**
- **RC10 前端新建**：默认向后端传 `require_recoverable: true`，缺少 `SHARE_LINK_KEY` 时阻止无意间创建无法找回的新地址。仍提供显式勾选的旧兼容模式，只有清楚接受风险才允许生成不可恢复地址；旧的 API 调用（未传该字段）不被破坏。
- **只有创建分享的登录账号可读取原令牌与修改该分享**。能访问同一团队文件，不意味着可以读取其他成员创建的私有分享令牌。
- 修改或移除分享页面密码会撤销之前已验证的访客访问会话；修改有效期、下载限制、下载开关不会更换 URL。

## Cloudflare 网页端升级步骤

1. 为生产 D1 与重要 R2 文件做好备份；不必重建现有 Worker、数据库或桶。
2. 如尚未设置，从安全位置生成 **32 字节随机密钥（64 字符十六进制）**，在 Cloudflare Dashboard → Worker `cloudflare-disk` → **Settings → Variables and Secrets → Add Secret**，变量名为 `SHARE_LINK_KEY`，类型为 Secret。**若已经设置且使用过，必须保持原值**。
3. 在 GitHub `main` 合并 RC10 补丁。已有 Build Command `npm run build`、Deploy Command `npm run deploy` 不变。
4. 部署脚本自动应用 **`0016_rc10_existing_links.sql`**。这个迁移只为 `shares` 添加可空的 `link_origin` 字段，不改动老记录，不需要清空数据库。
5. 部署后登录 `/files`，点击已经分享过的文件中的「分享 / 管理」，查看原 URL、编辑期限和权限，确认不生成多余的新记录。
6. 如果提示 `SHARE_LINK_KEY` 无效或链接解密失败，**不要修改密钥或反复轮换**，先恢复原来使用的 Secret。

PowerShell 生成随机密钥示例（在你自己的电脑运行，勿提交 Git）：

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
[BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
```

## 接口变化

- `GET /api/v1/shares?target_type=file&target_id={id}`：仍只列出当前登录账号拥有的分享，不返回任何原始 bearer token。
- `GET /api/v1/shares/{id}/link`：已加密且当前账号仍具备分享权限时，可返回**活跃、已过期或下载次数耗尽**的原链接（以前仅活跃分享）。不返回被撤销或权限失效的链接。
- `PATCH /api/v1/shares/{id}`：沿用现有属性编辑接口，不修改令牌、类型或创建者。现有密码修改会撤销访客会话。
- `POST /api/v1/shares`：增加可选布尔参数 `require_recoverable`。设置为 true 时，无正确 `SHARE_LINK_KEY` 返回 `SHARE_LINK_KEY_REQUIRED`，且不写入分享。旧调用省略此参数仍保持兼容。
- `POST /api/v1/shares/{id}/rotate`：与此前一样会废止旧 URL，并更新 `link_origin` 为本次新建链接的域名。
- `GET /api/v1/publications?file_id={id}`：公开副本链接可直接按 publication ID 构造，不依赖可恢复的私密令牌。

## 验证范围与上线注意

RC10 已使用真实 SQLite SQL + 模拟 R2 执行 API 集成测试，额外针对同一分享的原 URL 恢复、属性编辑、过期续期、旧哈希链接轮换、跨用户拒绝和迁移兼容进行了检查。还使用 headless Chromium 的页面 DOM 注入方式检查弹窗基本交互。**不能视为已经连接生产 Cloudflare 完成端到端测试**。

本改动不对已存在的分享令牌进行批量轮换，也不会自动撤销旧链接；只有用户主动选择「轮换」或「撤销」才会更改链接访问状态。
