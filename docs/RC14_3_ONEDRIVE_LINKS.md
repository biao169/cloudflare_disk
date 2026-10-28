# RC14.3 OneDrive 固定入口与管理

本版本实现可部署的固定来源入口（`/r/od_<32 hex>`）与登录用户的创建、列出、撤销功能。**这是 OneDrive 原分享页的固定入口，不是文件下载直链。** 微软 Graph 的 `@microsoft.graph.downloadUrl` 属于短期、预授权 URL；RC14.2 尚未提供 OAuth，所以本次不生成或缓存它，也不使用管理员令牌代替游客身份。

## API

- `POST /api/v1/tools/onedrive/links` JSON `{ "url": "https://1drv.ms/..." }`：需要 CloudDrive 登录；返回 `delivery:source_page_redirect`，创建固定入口。
- `GET /api/v1/tools/onedrive/links`：登录用户个人固定入口列表，最多 100 条。
- `DELETE /api/v1/tools/onedrive/links/:id`：仅创建者撤销。
- `GET|HEAD /r/od_<32-hex>`：未撤销时 302 跳到经过再次校验的原始分享链接；已撤销或过期时 410；不缓存响应。

## 部署

1. 备份 D1 和 R2。2. 应用迁移 `0024_rc14_3_onedrive_fixed_links.sql`。3. 部署 Worker 和静态资产。4. 使用登录账户测试创建 / 访问 / 撤销。

## 安全和限制

- 不接受任意目的地 URL；重定向前复用严格 OneDrive URL 白名单校验。
- 不保存微软临时直链或授权令牌。
- 创建、撤销需要 CloudDrive 用户身份与原有请求来源校验；游客仍能使用 RC14.1 格式解析，但不创建持久链接。
- 固定入口不承诺源文件仍然存在、分享权限仍然有效、来源网页会提供直接下载，也不绕过 Microsoft 登录。
- 本版本尚无微软 OAuth、Graph 下载、自动刷新缓存、来源状态健康检测、下载错误重试；这些不能被本地回归测试认定为完成。
