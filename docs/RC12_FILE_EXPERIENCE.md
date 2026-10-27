# CloudDrive RC12 — 全局搜索、拖拽上传、目录导航、批量进度和收藏夹

**升级基线：RC11。** 当前项目仍使用原生 HTML + Bootstrap + ES Modules，前端无编译；Workers、D1、R2 名称与原有账号/分享令牌保持不变。

## 功能与限制

1. **跨空间全局搜索 `/search`**：只返回当前用户在个人/团队空间内具有 `read` 权限的已就绪文件和未删除文件夹。支持类型过滤、基于更新时间的分页；逐次最多扫描 240 条候选，每批 40 条并批量判定 ACL。关键词最多 46 UTF-8 字节，`%`、`_` 和反斜线作为普通字符处理。它是文件名模糊检索，不读取文件内容；大规模 D1 上 `%关键词%` 查询会扫描元数据，请按免费用量控制搜索频率。
2. **拖拽上传**：在 `/files` 当前空间及目录内拖入文件/文件夹；Chrome/Edge 使用 `webkitGetAsEntry` 递归枚举，选文件夹按钮使用 `webkitdirectory`。同名文件夹可复用，但必须仍具备写权限；不覆盖已有同名文件。每次最多 500 个文件，最多 12 层子目录；超过普通上传阈值的文件仍使用已有 R2 Multipart/断点续传。单批按顺序上传，避免超量并发耗尽 Workers Free 配额。拖入空目录本身不会创建空目录（只创建所含文件的父目录）。
3. **常驻目录树**：在 `/files` 添加可折叠目录树、懒加载（单次 100 条）及面包屑；可在 `/search` 或 `/favorites` 点击“定位”跳入授权文件夹。记录最近打开目录到当前浏览器的 `sessionStorage`，**不存储 Cookie/令牌/文件内容**；重新进入目录仍以最新 ACL 为准。
4. **批量任务进度**：移动/复制/移入回收站沿用现有 10 项/批 API，现在显示完成数、失败数、失败明细，支持停止后续批次。上传采用 XHR 小文件百分比与 Multipart 大文件分片百分比。客户端关闭后任务进度面板不持久化，已经提交给服务端的操作不受页面关闭撤销；大文件上传恢复依然使用已有本地上传会话。
5. **收藏夹 `/favorites`**：用户可对自己有读取权限的文件和文件夹设置收藏；收藏只保存在 D1，不增加 R2 空间。收藏记录**不会授权**：移除团队成员、撤销 ACL、文件进回收站后，对应项目自动不再显示。旧无效收藏可能保留一条 D1 记录，未来可批量清理。

## 新增 D1 迁移

`migrations/0018_rc12_file_experience.sql`：新增 `favorites` 表和搜索辅助索引，不改变已有 `users`、`files`、`shares`、上传记录及对象引用；首次部署与升级使用原来的自动部署脚本。建议提前备份正式 D1 和关键 R2 对象。

## 新增 API（均校验登录）

| 方法 | 路由 | 作用 |
|---|---|---|
| GET | `/api/v1/search/global?q=term&type=all&limit=30&cursor=...` | 跨授权空间搜索（文件名） |
| GET | `/api/v1/favorites?limit=30&cursor=...` | 用户个人收藏（实时 ACL 过滤） |
| POST | `/api/v1/favorites` | `{"kind":"file|folder","id":"UUID"}` 收藏 |
| DELETE | `/api/v1/favorites/{file|folder}/{UUID}` | 取消自己的收藏，幂等 |
| POST | `/api/v1/favorites/check` | `{"items":[{"kind":"file","id":"UUID"}]}`；最多 40 项 |
| GET | `/api/v1/folders/{UUID}/path` | 根据 ACL 返回从空间根目录到当前目录的面包屑 |

所有过滤与分页在 Worker 后端执行。客户端不得通过收藏 ID 绕过现有 `files/:id/content`、预览或分享权限检查。

## 部署指南

1. 保留当前 `wrangler.jsonc` 的 Worker 名称 `cloudflare-disk`、DB、R2、CDN 及域名。安装 RC12 增量补丁后核对 `git diff -- wrangler.jsonc`。
2. 执行 `npm run build`，它将进行 JS 语法校验、原有测试和新增测试，以及迁移安全检查。
3. 推送 GitHub `main`；Cloudflare Builds 保持 **Build Command `npm run build`，Deploy Command `npm run deploy`**。部署会在现有 D1 上运行 0018 迁移。
4. 访问 `/api/v1/health/ready` 确认 READY，再登录 `/files`，查看左侧目录树、新上传入口；侧栏出现 `/search` 和 `/favorites`。

RC12 **不需要新 Secret，不要求重新初始化管理员，也不应重新创建桶**。特别不要覆盖或更换 `BOOTSTRAP_TOKEN`、`SHARE_LINK_KEY`。

## 验证边界

自动化使用 Node.js、SQLite D1 兼容测试和内存 R2；不代表已完成生产 Cloudflare 验收。当前执行环境浏览器对环回服务器返回管理策略阻断；通过 `page.set_content`、动态 ES Modules 和模拟 API 的 Chromium DOM 冒烟检查已覆盖文件列表、目录树、收藏、全局搜索、拖拽上传和批量任务进度，但不能替代 Windows Wrangler/实际生产 API 的端到端联调。部署前先备份生产数据。
