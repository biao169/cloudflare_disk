# RC14.12 — 独立 OneDrive 配置页签与匿名解析界面调整

## 本次修改

- **系统设置** `/settings` 新增 **OneDrive 配置** 页签，快捷链接：`/settings?tab=onedrive`。它与 **备份与恢复**、**站点设置** 等页签同级。
- Microsoft OAuth 应用配置诊断、授权与断开、Graph 接口说明、PowerShell 密钥生成教程、OneDrive 同步设置、解析工具总开关、匿名使用开关、游客/登录用户解析配额以及配额统计，都移动到 **OneDrive 配置**。
- **站点设置** 不再混入 OneDrive API 配置和解析配额；其他站点配置保留。
- **OneDrive 文件** 页面中的「账户设置」跳转到 `/settings?tab=onedrive`。Microsoft OAuth 完成或失败后也返回相同页签，失败说明使用脱敏错误码，不包含 OAuth code/state。
- `/tools/onedrive` 匿名游客在允许匿名解析时只显示分享 URL 的输入、解析结果及 Graph 分享令牌复制，不再显示公开直链探测、固定链接创建与列表或 Microsoft 账号连接按钮。**后端同时拒绝游客调用 `/public-check`，避免只靠隐藏按钮控制权限。**
- 如果关闭匿名解析，游客不能提交解析且会看到需要登录的提示；已登录用户可使用公开探测、固定入口管理。Microsoft 账号连接与文件授权操作统一在系统设置的 OneDrive 配置页签进行。

## 操作与配置说明

1. 使用超级管理员账户打开 `/settings?tab=onedrive`。
2. 在「OneDrive 解析工具 · 访问权限与配额」设置总开关和匿名解析开关。每个参数下方都提供用途说明。
3. 在下面的「Microsoft OneDrive 账户与文件直链」按内置教程核对 `MS_CLIENT_ID`（客户端 ID）、`MS_CLIENT_SECRET`（客户端密码的 **Value**）和 `MS_TOKEN_KEY`（自生成且需长期保留的加密密钥）；连接 Microsoft 账号。
4. 同步设置和已发布链接仍可从此页或独立的 `/onedrive` 文件管理页访问。
5. 使用无痕浏览器打开 `/tools/onedrive`，确认仅出现解析表单，不出现固定链接/微软授权按钮；再关闭匿名开关确认游客被拒绝。

## 部署

使用 RC14.12 最新下载重定向修复版作为基线。建议备份代码，覆盖增量补丁后运行：

```bash
npm run build
npm run deploy
```

无需新增 D1 数据库迁移或 Worker 变量。保留已有 `wrangler.jsonc` 的绑定、`MS_TOKEN_KEY`、D1、R2 及所有固定链接。源码中的 `keep_vars` 仍用于保留后台普通文本变量。

## 安全与兼容性

前端按后端 `/api/v1/tools/onedrive/status` 返回的 `authenticated` 和 `anonymous_enabled` 决定是否渲染管理按钮；按钮隐藏不是唯一保护，Worker 的链接创建及 Microsoft 授权接口仍独立做登录/管理员权限检查。未修改 `/r/od_*`、`/r/odf_*` 和 `/s/odf_*` 的行为。

本地测试覆盖匿名允许/关闭、登录用户管理、后台权限和 OAuth 反馈跳转。真实 Cloudflare 站点还需在部署后用无痕窗口验收。
