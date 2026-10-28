# RC14.1 OneDrive 匿名链接解析基础

## 现有功能
- 公共页面：`/tools/onedrive`，不要求 CloudDrive 会话。
- `GET /api/v1/tools/onedrive/status`：公开状态查询，受工具与匿名开关限制。
- `POST /api/v1/tools/onedrive/resolve`：提交 JSON `{ "url": "https://1drv.ms/..." }`，返回链接类型、CID（如可识别）、Graph 分享令牌和未验证状态。
- 超级管理员：系统设置中控制 `onedrive_tool_enabled`（默认 true）和 `onedrive_anonymous_enabled`（默认 true），D1 `app_settings` 持久化，无需新迁移。
- 前后端均明确告知“格式有效不代表可下载”，不会伪造临时下载地址。

## 注意
- RC14.1 **未实现** Graph OAuth/授权、临时直链生成、固定直链创建、文件内容获取或下载；这些列为后续阶段。
- 服务端仅解析经过严格校验的微软域名 HTTPS 链接；不发起外部 fetch，规避本阶段 SSRF。
- 公共解析不消耗 Microsoft API 额度，但匿名请求的全局频率/配额需 RC14.2 完善；生产环境可先由 Cloudflare WAF 对 `/api/v1/tools/onedrive/*` 加上速率规则。
- 如果关闭匿名，登录用户仍可用工具；关闭工具总开关后全部用户停用解析。

## 验收
`npm run build` 运行语法、迁移检查、单元和 SQLite/R2 集成测试。
