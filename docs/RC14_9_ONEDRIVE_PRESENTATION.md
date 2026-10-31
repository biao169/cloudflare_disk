# RC14.9 — OneDrive 可视化分享页面与在线预览

> 本阶段在 RC14.8（独立 OneDrive 文件浏览）上增量开发。数据库仍使用 UTC；前端自动转换浏览器本地时区。微软账号仍由 CloudDrive 超级管理员 OAuth 授权。

## 一、功能入口

1. 超级管理员登录 `/onedrive` → 浏览文件 →「发布直链」。明确确认公开后，系统保留原下载地址 `/r/odf_<ID>`，并新增分享页面 `/s/odf_<ID>`；新发布后自动弹出展示编辑窗口。
2. 在「OneDrive 文件 → 已发布直链」中，可查看分享页面、复制分享页或下载直链、编辑展示、撤销。
3. 展示编辑支持标题（140 字）、介绍（1200 字）、显示名称（80 字）、封面风格、在线预览开关，以及上传 2 MB 内的 JPEG/PNG/WebP 自定义封面。每个字段都有界面帮助说明。
4. 任何获得分享页面地址的人，可查看已明确发布的文件信息，复制下载地址或扫码访问。公开页面不要求 CloudDrive 登录。
5. 二维码在浏览器本地生成，无须调用第三方二维码服务，也不会将链接发送给其他二维码服务。

## 二、两种固定链接的关系

| 地址 | 作用 | 权限与兼容 |
|---|---|---|
| `/s/odf_...` | 分享展示页面、文件介绍、二维码、预览 | 新增入口；公开访问，与已发布文件绑定 |
| `/r/odf_...` | 文件直链；向当前微软预授权下载地址返回 302 | 原有入口、ID 与下载行为完全保留 |

**管理员主动发布意味着任何持有地址的人可利用其授权访问该文件。** 不要发布私人内容、密码、敏感资料。撤销发布后新的 `/s/`、`/r/` 请求会被阻断，但之前已经下发的短期 Microsoft 下载地址可能仍有短暂有效期。密码保护、有效期与严格下载控制仍计划在 RC14.11；本阶段不要将普通公开直链当作有访问控制的私有链接。

## 三、预览策略

- 支持的在线 MIME 类型：`image/jpeg`、`image/png`、`image/webp`、`image/gif`、`application/pdf`、`video/mp4`、`video/webm`。不支持 SVG、HTML、Office 原生文档的任意嵌入。
- `/api/v1/public/onedrive/{id}/preview` 只允许访问 **active + preview_enabled** 的已发布文件，并每次校验原始文件的真实 MIME 类型；Microsoft Graph OAuth 密钥不会返回给客户端。
- 图片、PDF 和视频在 Worker 侧以流式响应发送；支持 `Range` / `206 Partial Content`，便于视频进度跳转。预览限制：图片约 25 MB、PDF 60 MB、视频 1 GiB；超限请使用原直链下载。
- Microsoft 可能对浏览器内嵌 PDF、视频或缩略图提供不同的响应头或格式；不支持时显示友好提示，保留下载按钮。
- **没有使用 Graph `preview` API 生成的授权嵌入链接**，因为微软明确警告这类链接可能继承调用者的访问权限。源文件存储在 OneDrive，不自动同步至 R2。

## 四、封面与二维码

- 默认使用 Graph `/thumbnails` 获取自动封面；Graph 不支持或无缩略图时显示文件图标。
- 可选择「简洁图标 / 海蓝 / 淡紫 / 薄荷绿」等封面风格，不产生额外存储。
- 自定义封面校验 MIME 和文件头，采用随机私有 R2 Key，上传时替换旧封面；删除封面或撤销分享时清理对应对象。R2 删除失败会保留无效的私有对象，需在后续运维阶段核对。
- 二维码在本地浏览器生成 SVG，可保存为矢量文件。包含离线 QR 生成器，保留第三方 MIT 许可说明。

## 五、新增路由与 API

| 方法 | 地址 | 说明 |
|---|---|---|
| GET | `/s/odf_<ID>` | 公开 HTML 分享页 |
| GET | `/api/v1/public/onedrive/<ID>` | 公开安全字段，不返回 drive_id、item_id 或下载预授权 URL |
| GET / HEAD | `/api/v1/public/onedrive/<ID>/cover` | 自定义 R2 封面或 Graph 缩略图；不可用时 404/503 |
| GET / HEAD | `/api/v1/public/onedrive/<ID>/preview` | 受控媒体预览、Range 转发 |
| PATCH | `/api/v1/admin/onedrive/drive/publications/<ID>` | 管理员更新展示字段 |
| PUT | `/api/v1/admin/onedrive/drive/publications/<ID>/cover` | 管理员直接上传图像，最多 2 MB |
| DELETE | `/api/v1/admin/onedrive/drive/publications/<ID>/cover` | 管理员删除自定义封面 |

旧接口 `POST .../drive/publish`、`GET .../drive/publications`、`DELETE .../drive/publications/{id}` 保留，并增加展示信息和分享页地址。管理接口逐次验证超级管理员，不能匿名操作。

## 六、数据库及部署教程

**新增唯一 D1 迁移：** `migrations/0028_rc14_9_onedrive_presentation.sql`。对旧 `onedrive_drive_publications` 表仅添加列，不重写、不删除旧 ID 或公开文件。

1. **先备份** Cloudflare D1 数据库和现有 Worker 项目；如果有重要封面，也备份私有 R2。
2. 在已有 RC14.8 项目上覆盖 RC14.9 补丁（或使用完整项目作为基线），保留真实 `wrangler.jsonc` 的资源名称与绑定。
3. 运行 `npm run build`，确认迁移安全、语法与单元/集成测试全部通过。
4. 使用项目既有命令 `npm run db:migrate:remote` 对目标生产 D1 执行迁移；按项目部署脚本提示检查迁移状态。**不要清空 D1**。
5. 执行 `npm run deploy` 部署；如部署脚本会自动迁移，确保不要对不同环境重复手动初始化。
6. 在管理员登录下测试 `/onedrive`、新发布文件和旧文件的 `/s/odf_*`、`/r/odf_*`。再使用无痕窗口访问公开分享页、预览、二维码、撤销后状态。

本阶段**不需要新增微软环境变量或重绑账号**。继续保留 `MS_CLIENT_ID`、`MS_CLIENT_SECRET`、`MS_TOKEN_KEY`、`MS_TENANT`、回调地址以及 D1、`PRIVATE_BUCKET`、`PUBLIC_BUCKET` 绑定。切勿随意更换 `MS_TOKEN_KEY`。

## 七、回归和已知限制

- 跨浏览器验证 JPEG/PNG/WebP/GIF、PDF 和 MP4/WebM；特定浏览器缺少解码器时视频不能预览，但仍可下载。
- 原文件更新后展示页部分元数据仍保留发布时快照；下载时仍动态获取当前文件。自动元数据同步预留 RC14.12。
- 不支持文件夹、合集、批量分享、密码、到期时间、下载次数限额；依开发计划在 RC14.10–14.11 实现。
- 分享页面 SEO/Open Graph 摘要目前由前端加载，社交平台爬虫不一定能读取动态文件封面；如确需链接卡片可后续加入服务器渲染。
- 浏览器实际访问数据由微软提供，不能将本地 Graph Mock 测试等同于真实个人版/企业版 OneDrive 全部通过。
