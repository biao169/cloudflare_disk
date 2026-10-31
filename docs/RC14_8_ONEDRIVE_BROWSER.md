# RC14.8 — OneDrive 可视化文件管理

## 入口及权限

- 超级管理员登录 CloudDrive 后，在左侧菜单点击 **OneDrive 文件**，或者进入 `/onedrive`。
- 「系统设置 → Microsoft OneDrive 账户」只用于 OAuth 授权、Secret 配置和连接状态检查；连接成功后点击「打开 OneDrive 文件管理」即可转到独立页面。
- 现有 `/tools/onedrive` 匿名分享链接解析工具保持独立，后台匿名权限与配额逻辑不变。
- `/api/v1/admin/onedrive/drive/*` 仍由 Worker **逐次校验超级管理员身份**；普通登录用户/访客不能访问文件名、缩略图或管理员授权 Token。

## 文件浏览

| 操作 | 使用说明 |
|---|---|
| 文件夹导航 | 点击文件夹「打开」进入；上方路径可返回任一上级目录。 |
| 搜索 | 顶部搜索栏查询**整个 OneDrive**，支持中文和部分内容/元数据搜索；输入后自动发起搜索，或点击「搜索」。 |
| 文件筛选 | 文件夹、图片、视频、文档、音频或其他。**筛选只作用于已经加载的数据**。 |
| 排序 | 文件夹浏览优先使用微软 Graph 的 `$orderby`，若不兼容自动降级为按已加载条目排序；全盘搜索仅对已加载结果排序。 |
| 分页 | 每次请求最多 60 项；点击「加载更多文件」，直到全部加载。单次不会再截断至 100 项。 |
| 视图 | 「网格/列表」两种显示，自动保存在当前浏览器 `localStorage`。 |
| 缩略图 | 图片、视频及支持的文档优先使用 Graph 列表缩略图；企业版不支持批量返回时在进入可视区域后最多 3 个请求并发按需获取。缩略图可能不可用，显示类型图标。 |
| 多选 | 选择当前可见项、跨文件夹保留选择、复制选中文件名和清除选择。当前阶段仅支持**单个选中文件直接发布**；文件合集/批量发布安排 RC14.10。 |
| 分享 | 单个文件「发布直链」前必须明确确认公开风险。直接复用 `/r/odf_*` 固定下载入口与 `onedrive_drive_publications` 表。 |
| 已发布 | 顶部「已发布直链」可复制或撤销旧链接；不会更改原有链接 ID。 |

当前全部时间仍由前端公共 UTC 模块转换为浏览器时区。PC 与移动端均有响应式布局。

## 主要 API

所有 API 路径均为超级管理员专用，需站点登录 Session；无凭证访问返回 401，其他用户返回 403。

- `GET /api/v1/admin/onedrive/drive/browse?parent=root&sort=name_asc`：浏览根目录。
- `GET .../browse?parent=ITEM_ID&sort=updated_desc`：浏览指定文件夹。
- `GET .../browse?q=hello&sort=name_asc`：搜索整个 OneDrive；不要求传 Graph URL。
- `GET .../browse?...&cursor=OPAQUE_CURSOR`：分页加载下一批。前端只能使用服务器签名的游标，游标绑定目录、搜索词和排序，15 分钟过期。
- `GET /api/v1/admin/onedrive/drive/thumbnail?item=ITEM_ID`：按需查询缩略图，可能返回 `url:null`。
- 兼容旧接口 `GET .../drive/items`、`POST .../drive/publish`、`GET .../drive/publications`、`DELETE .../drive/publications/{id}`。

搜索游标中只包含可信 `https://graph.microsoft.com/v1.0/me/drive/` 的受限制路径；签名密钥经 HKDF 从原有 `MS_TOKEN_KEY` 域分离派生。分页游标不包含 OAuth Access Token，也不能通过修改 cursor 任意请求 Graph API。

## 兼容性与限制

1. 不要求新增环境变量或 D1 迁移；**绝对不要因为升级而更换 `MS_TOKEN_KEY`**，否则已保存的 OAuth Token 将无法解密。
2. 图像缩略图来自微软，Graph 可能不返回缩略图，或下载 CDN 地址失效；此时显示本地文件类型图标。某些 OneDrive for Business/SharePoint API 不支持 `$expand=thumbnails`，本版本自动回退。
3. OneDrive Graph 搜索可能在文件内容或元数据上命中；搜索结果不一定只匹配文件名。
4. 无法保证微软所有账号类型的搜索、大小排序和缩略图完全一致；降级行为在界面显示。
5. 单文件分享仍然是管理员**主动公开**，获得 `/r/odf_*` 链接的任何人都可能下载管理员已授权的内容。不要把私人文件发布成公开直链。
6. OAuth 账号连接、Token 刷新和临时下载重定向逻辑不变。RC14.8 **没有**实现文件夹公开分享、合集、批量发布、公开预览页、二维码或精细访问控制；这些功能在后续阶段完成。

## 升级与回归

1. 备份生产源码与 D1。完整包用于替换代码；增量补丁应在 **RC14.7 OAuth Callback Fix** 基线上覆盖相同相对路径。
2. 保留当前 Worker 名称、D1/R2 绑定和所有 Secret。
3. 运行 `npm run build` 检查迁移、语法及单元/集成测试，再使用既有 `npm run deploy` 发布。
4. 验证 `/onedrive`、`/settings`、`/tools/onedrive`、`/r/odf_*` 四类入口的授权与兼容性。
5. 使用真实个人 OneDrive 和企业 OneDrive 测试目录超过 100 项、中文搜索、缩略图、排序、浏览器本地时区及授权失败恢复。

测试环境只通过模拟 Graph 和本地 SQLite 集成验证；**未连接你的 Microsoft 账号**，无法声称真实账号下所有扩展都完成端到端验证。
