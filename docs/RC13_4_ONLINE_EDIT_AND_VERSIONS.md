# RC13.4：在线文本编辑、历史版本恢复与公开版本管理

> 基于 RC13.3 增量升级。前端继续采用原生 HTML + Bootstrap + ES Modules，零前端编译。**无新建 D1 迁移，无新增必需 Secret，不更换现有 Worker、D1、R2 或分享链接。**

## 一、网页入口和操作方法

1. 登录 `/files`，选择 TXT / Markdown / JSON / XML / CSV / HTML / CSS / JS / YAML / LOG / INI 等文本文件，点击 **在线编辑**。
2. 在线编辑器通过后端读取 UTF-8 原文；点击保存或 Ctrl+S 创建新的修订，文件 ID 不变，旧私密分享继续指向当前内容。已公开且开启自动同步的文件会复用 RC13.2 发布流程。
3. 每个文件的 **历史版本** 按钮现在打开完整的 Bootstrap 弹窗，支持查看修订号、大小、时间、文本或常见图片/PDF/视频预览、下载历史对象，以及确认恢复旧修订。恢复生成新的修订号，并不改写/删除以前版本。
4. 管理员在 `/shares` 的永久公开直链区域点击 **版本与同步**；也可以从文件的 **分享 / 管理** 弹窗中进入。可查看当前已发布修订、私有文件最新修订、历史发布记录和旧 CDN 同步状态；支持暂停/恢复自动同步、手动发布当前修订、重试原始 CDN 地址同步或刷新缓存。

## 二、在线编辑的服务端约束

- 文件类型以服务器验证的文件名扩展名和原 MIME 综合判断；SVG 不开放在线编辑，二进制格式不允许。
- 文件大小和保存的 UTF-8 字节数上限为 **512 KiB**；请求体上限 **2 MiB**。不进行 Office 解码、图片视频转换，也不提供服务端 HTML/JS 执行。
- 只能读取合法 UTF-8、无 NUL 和无无效代理字符的文本；旧数据不是 UTF-8 时应下载转码后重新上传覆盖。
- `GET /api/v1/files/:id/text` 需要现有文件读取权限；`PUT .../text` 需要写权限，强制提供 `expected_revision`，不允许静默覆盖他人的新修订。
- `PUT .../text` 通过服务端委托 **已有 `uploadFile()` 替换引擎** 执行，因此复用容量预留、R2 不可变对象、D1 比较并交换、历史版本保存、RC13.2 公开副本准备和失败补偿；没有另写一套风险更高的覆盖流程。
- 内容只能作为编辑器 textarea 的 `.value` 显示，不能用 `innerHTML`、`srcdoc`、动态执行或将 HTML 当作与网盘同源的可执行页面预览。
- 保存失败、修订冲突时保留编辑器文本，提示复制尚未保存的内容；关闭含未保存内容的窗口前要求确认。

## 三、历史修订和权限

| 请求 | 方法 | 含义与权限 |
|---|---|---|
| `/api/v1/files/:id/text` | GET | 按文件 ACL 读取当前 UTF-8 内容与修订号 |
| `/api/v1/files/:id/text` | PUT | 保存 `{content, expected_revision}`，需要写权限、返回新修订 |
| `/api/v1/files/:id/versions` | GET | 有读取权限才可查看历史修订列表 |
| `/api/v1/files/:id/versions/:rev/text` | GET | 只读 UTF-8 历史文本，不能保存到原修订 |
| `/api/v1/files/:id/versions/:rev/content` | GET、HEAD | 授权下载历史对象，支持单区间 Range、ETag 和 no-store |
| `/api/v1/files/:id/versions/:rev/preview` | GET、HEAD | 只支持已经认可且文件头验证通过的图片、视频、PDF |
| `/api/v1/files/:id/versions/:rev/restore` | POST | 恢复为新修订，可提交 `expected_revision` 乐观并发校验；需要写权限 |

**注意：** 当前文件夹 ACL 授予的读取权限同样可以读取该文件的历史版本。将用户加入有敏感历史内容的目录前，请了解此授权范围。旧版 `file_versions` 已存对象继续占用 R2 空间；自动生命周期清理将在 RC13.5 继续完善。

## 四、公开版本与 CDN 管理

| 请求 | 方法 | 含义与权限 |
|---|---|---|
| `/api/v1/publications/:id/status` | GET | 超级管理员查看当前公开修订、最新私有修订、同步状态和永久 `/r/` URL |
| `/api/v1/publications/:id/versions` | GET | 超级管理员查看公开历史修订和对象大小（最多 30 项） |
| `/api/v1/publications/:id` | PATCH | `{auto_sync:true/false}` 设置公开自动同步；仅超级管理员 |
| `/api/v1/publications/:id/publish-latest` | POST | 手动把私有当前修订发布到原永久链接；仅超级管理员 |
| `/api/v1/publications/:id/sync` | POST | 尝试原 CDN 固定路径副本的同步和缓存清理；仅超级管理员 |

手动发布先把新公开版本上传至**独立 R2 Key**，再通过 D1 指针比较并交换切换当前公开版本。提交成功后 `/r/{id}` 重新解析新版本；不存在缓存承诺。若 R2 复制失败，旧版本继续可访问。旧 CDN 兼容路径如 `/published/*` 仍通过异步任务维护，可能受到浏览器、CDN 缓存影响。

暂停 `auto_sync` 期间，文件在线编辑只更新私有文件和私密分享，**不会自动修改 `/r/` 已发布修订**。管理员可在版本管理界面手动发布当前修订；重新打开自动同步后，今后的新修订会正常自动发布，但暂停期间已经形成的差异仍应手动同步一次。

手动发布受到现有 R2 物理存储软配额控制。服务器返回 `409` 表示并发冲突，`503 COMMIT_OUTCOME_UNKNOWN` 表示数据库提交结果无法确定，**不能据此删除存储对象或盲目重试**，请先通过只读状态页核对。

## 五、Cloudflare 网页部署

项目仍采用：

- Build Command：`npm run build`
- Deploy Command：`npm run deploy`
- Branch：`main`
- Worker：`cloudflare-disk`
- D1：`clouddrive-db`；R2：`clouddrive-private` / `clouddrive-public`
- 保留原 `SHARE_LINK_KEY`、`BOOTSTRAP_TOKEN` 等运行时 Secret，**不用重新初始化数据库**。

本版无新增 D1 migration（RC13.3 的 `0021` 仍保留）。已有 `/api/*` 走 Worker，无需为在线编辑加新的静态资源动态路由。

生产环境直接 GitHub 自动部署时，应先按现有运维说明备份重要 D1/R2 数据，执行 `npm run build` 并审查 `git diff -- wrangler.jsonc`。线上需人工检查实际浏览器文本编辑弹窗、版本预览、手动发布和 CDN 缓存行为。

## 六、实际验证范围

- Node.js 单元测试、SQLite + 模拟 R2 API 集成测试和 JS 语法扫描可自动执行 `npm run build`。
- RC13.4 专项覆盖 UTF-8 文本、共享链接保留、旧修订恢复、冲突与 ACL、HTTP Range、编辑后 `/r/` 切新版、暂停自动同步后手动发布。
- 由于当前环境阻断浏览器访问本地环回及测试域名，**未完成真实浏览器自动化端到端测试**；也未连接或变更你的 Cloudflare 生产账户。
