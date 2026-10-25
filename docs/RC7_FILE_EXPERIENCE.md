# RC7 — 文件管理与就地分享操作（基于 RC6 增量升级）

## 目标与约束

- 在已部署 `cloudflare-disk` 的原有 Worker 上部署，不更换 R2 Bucket / D1 数据库 / 初始化管理员。
- `public/` 保留原生 HTML + CSS + ES Modules，Bootstrap 使用仓库内本地静态文件，不增加前端编译。
- 对原有数据的数据库改动只有 `migrations/0013_rc7_file_browser.sql` 中两个 `CREATE INDEX IF NOT EXISTS`；无需重建表。
- API 路由仍由 Worker 统一鉴权。前端隐藏操作不等于后端权限。

## 用户界面

`/files`：支持空间切换、文件夹面包屑、目录选择弹窗、列表/网格、按名称/大小/修改时间排序、类型筛选、名称搜索、分页以及多选批量操作。支持个人文件的原生浏览器下载（不用 `fetch().blob()`）。

`/recent`：真正读取 `files.updated_at`、按更新时间倒序聚合用户可访问的不同空间中的文件，使用游标分页。此页面始终以更新时间排序；搜索/文件类型过滤仅作用于当前页。如果在权限过滤后没有达到分页数量，服务端最多扫描 240 条原始候选记录，避免无限 D1 查询。

每行文件或文件夹都有 **分享** 按钮，会弹出 Bootstrap Modal；不跳转到 `/shares`：

| 模式 | 文件 | 文件夹 | 时效 | 其他 |
|---|---|---|---|---|
| 临时授权直链 | 支持 | 不支持 | 1 小时、1/7/30 天、自定义 | 无需密码，过期/撤销阻断新请求 |
| 文件分享页面 | 支持 | 支持 | 同上，亦可永久 | 可设独立分享密码、是否提供下载按钮 |
| 永久公开直链 | 超级管理员 | 不支持 | 固定公开 | 创建独立 R2 公开副本，可能被 CDN/浏览器缓存 |

页面保留 `/shares`，现在仅用于查看/撤销既有分享及管理员公开发布，不再要求用户输入 UUID 创建新分享。原始匿名令牌**只有创建时出现一次**，D1 仅保存哈希，因此应立即复制保存；想换新链接需再次从文件操作弹窗创建。

> “不允许下载”不会阻止截图、录屏或提取已经传输给浏览器的预览字节。

## API 改动

| 方法和路由 | 功能和权限 |
|---|---|
| `GET /api/v1/files/recent?limit=30&cursor=` | 登录，跨空间读取本人有权限访问的最近文件，安全游标分页，默认 30、最大 50 |
| `GET /api/v1/spaces/:spaceId/folders?parent_id=&offset=&limit=` | 登录且有空间/目录读取权；返回可见子目录和 `can_write`、`parent_writable`，支持目录选择器，最大 100 |
| `GET /api/v1/spaces/:id/contents?...&sort=&filter=` | 继续复用现有文件目录 API，新增排序和类型筛选（allowlist），页大小默认 50 |
| `POST /api/v1/files/batch` | 批量移动文件+文件夹 / 批量复制文件（不支持目录批量复制）；最多 20 项，每项独立权限校验，返回逐项结果 |
| `POST /api/v1/trash/batch` | 批量软删除文件/文件夹（最多 20 项），逐项执行 RC6 回收站 ACL 校验 |
| `GET /api/v1/shares` | 返回本人分享记录及目标的展示名称（不返回原始令牌） |
| `GET /api/v1/publications` | 超级管理员公开发布列表带文件名（不改变权限） |
| `GET/HEAD /api/v1/files/:id/content` | 继续使用流式下载及 Range；改进 `If-Range` 对象 ETag 检查，HEAD 使用 R2 metadata |

**限制说明**：批量操作非跨 R2/D1 原子事务；成功/失败以每项的 `results` 为准。批量复制文件复用相同不可变 R2 对象引用，和以前一样不是物理复制；空间间移动/复制仍不开放。大目录的递归复制、跨空间迁移、跨页全选所有搜索结果不在本次版本范围内。

## 安全要点

1. 最近文件不能仅根据 `files` 搜索：必须先检查所属个人/团队空间，再检查文件夹 ACL；现在两层均已实施。
2. 目录选择器从授权 API 获取选项，但最终修改操作仍由 Worker 的 ACL 控制；手工伪造目标 ID 不会绕过校验。
3. 公开直链需要超级管理员，文件夹只能创建分享页面；临时/页面分享继续使用现有 `sharing.js` 令牌安全机制。
4. 用户文件名始终通过 `textContent` 渲染，避免将文件名拼接到 `innerHTML`。
5. 下载使用 `<a href="/api/v1/files/:id/content">` 跳转，服务器 `Content-Disposition: attachment`，浏览器负责流式写盘。Chrome/Edge 自带断点续传能力取决于浏览器与服务器；已支持标准单区间 `Range` 响应，不承诺任意多区间协议或断网自动续传。
6. 客户端批量操作按 10 个分批，不应把大量操作塞进单个 Worker 请求；服务端独立限制总数。

## 生产部署与恢复

1. 备份已有 D1 元数据和重要 R2 文件，不要仅依赖 Workers 代码回退。当前自动部署脚本保持不变。
2. 使用 RC7 **增量补丁**，保留现有 `wrangler.jsonc` 的 `name`、D1 ID / 数据库名、R2 Bucket 和自定义域名。仅将 `APP_STAGE` 更新为 `rc7-file-experience`。
3. 将本次修改提交推送至 `biao169/cloudflare_disk` 的 `main` 分支。
4. Cloudflare Worker → Settings → Builds 保持：Build Command `npm run build`，Deploy Command `npm run deploy`，Root Directory `/`。
5. 部署时会自动执行新增的 `0013_rc7_file_browser.sql` 索引迁移，随后发布新代码。不要清空数据库或重新创建 Worker。
6. 打开 `https://cloudflare-disk.2948531734.workers.dev/api/v1/health/ready` 应继续返回 `READY`；然后在 `/files` 查看真实文件及就地分享弹窗、`/recent` 查看最近文件。
7. 如果线上出现异常，先回滚 Worker 代码至 RC6；RC7 新增的两个非破坏性索引可保留，不需要回滚 D1 数据。没有任何自动操作会删除文件对象。

## 验证范围

- Node 语法、原有单元测试、D1 SQLite 迁移及模拟 R2 的 API 集成测试通过。
- 本次不能直接访问用户的 Cloudflare 管理账号执行线上部署；Chromium 浏览器在当前运行容器中访问本地环回地址受到平台限制，因此**没有完成真实浏览器交互联调**。
- 生产部署后应特别关注 `Worker 1101/1102` 错误、D1 读行和每次下载 R2 读取次数。Workers Free 的 CPU 限制没有改变。
