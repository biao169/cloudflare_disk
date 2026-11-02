# OneDrive 授权、解析与分享

## 访问入口

- `/tools/onedrive`：公开分享链接解析。管理员可在“系统设置 → OneDrive 配置”开启或关闭游客解析与设置配额；游客只显示解析表单。
- `/onedrive`：超级管理员的 OneDrive 文件管理器，提供文件夹树、搜索、分页、缩略图、批量选择、发布和“同步与运维”。
- `/settings?tab=onedrive`：Microsoft OAuth 连接、配置诊断、匿名开关、额度和同步控制，配置字段下方自带操作说明。

## Microsoft Entra 注册

1. 进入 https://entra.microsoft.com/ → 应用注册 → 新注册，按你的个人/企业 OneDrive 类型选择支持的账户。
2. 记录应用程序（客户端）ID：`MS_CLIENT_ID`；在“证书和密码”创建 Client secret，复制**值 Value**到 `MS_CLIENT_SECRET`，不要使用 Secret ID。
3. 添加 **Web** 回调 URI：`https://你的域名/api/v1/admin/onedrive/oauth/callback`；应用和网站发起授权时必须采用相同域名与路径。
4. 按 Graph 接口所需设置委托权限及用户同意；当前管理员分享读取场景需要满足实际 Graph Shares/Drive API 权限要求。谨慎授权，仅对受信任管理账号进行连接。
5. 使用安全随机数生成 `MS_TOKEN_KEY`：32 字节（推荐 64 位十六进制），与 Microsoft 的 Client secret 完全不同。该密钥用于本地加密 OAuth 令牌，**不要在已经连接后变更**。
6. 可选配置 `MS_TENANT=common`（组织与个人）或 `consumers`（仅个人）、`MS_REDIRECT_URI`（固定实际 HTTPS 回调地址）。
7. 变量必须绑定**当前部署的 Worker 运行环境**。Microsoft Secret 与 `MS_TOKEN_KEY` 放入 Secrets，不要放入 `vars`、README 或 Git。`wrangler.jsonc` 的 `keep_vars: true` 可保留后台的 Text 变量。
8. 在后台点击“连接 Microsoft 账户”完成授权；如报错，在诊断页查看 AADSTS、缺变量/格式异常、令牌刷新/回调状态。

## 分享与访问安全

- 仅超级管理员明确发布的 OneDrive 文件可进入本站公开固定链接；未发布的管理员私人文件不开放给游客。
- 文件分享同时提供可视化页面和固定下载入口；文件夹与合集使用静态成员快照，后续新文件不自动公开。
- 管理员可设置标题、简介、封面、预览、密码、有效期、成员可见和暂停恢复。
- Graph 下载 URL 有效期短，不保存在 D1；访问时动态获取。预览接口严禁直接向访客输出 Microsoft Access Token。
- 401/403、404、429、下载跳转被拦截、授权过期均属于不同错误。`MICROSOFT_DOWNLOAD_REDIRECT_UNTRUSTED` 可在后台诊断中查询被拦截主机名，不能因此关闭 SSRF 安全校验。
- 自动同步使用 Graph Delta 与分批健康检查，只更新已发布文件的状态；不会复制私人文件或发布新文件。

## 常见操作

- 发布单文件：`/onedrive` → 选文件 → 确认公开 → 编辑分享内容 → 复制 `/s/odf_*` 或 `/r/odf_*`。
- 发布文件夹：选择目录 → 创建分享 → 核对快照成员（默认不自动同步新增）→ 发布 `/s/odg_*`。
- 分享失效：管理端检查账户授权、来源文件是否存在、诊断下载错误码、Graph 限流及分享状态。
- 已绑定账户无法解密：检查 `MS_TOKEN_KEY` 是否与原值一致。重新授权可能恢复访问，但不会修复错误更换的密钥对应的旧密文。
