# RC14.10 — OneDrive 文件夹分享、文件合集与批量发布

## 适用范围与前提

从 RC14.9 升级。需已完成 Microsoft OAuth 管理员账号授权、D1 迁移 `0027`、`0028` 和本次 `0029`。无新的 Microsoft Secret、R2 桶或 Cloudflare Cron 要求。

**权限说明**：只能由 CloudDrive 超级管理员创建/修改/撤销文件夹和合集；公开页面匿名可读，且不需要访问 Microsoft Graph 来列目录。发布前需要管理员勾选确认。通过管理员令牌发布的 OneDrive 私有文件，会对取得 CloudDrive 链接的人开放下载；请仅分享确实允许公开的文件。

## 使用方法

1. 登录 CloudDrive 管理员账号，进入 **OneDrive 文件**（`/onedrive`）。
2. 在文件列表中选中：
   - **单个文件夹**：创建文件夹目录快照（含最多 8 层子目录）。
   - **任意多个文件或文件夹**：组成一个共享合集，可跨目录。顶级多选项及其子目录的层级保留。
   - **最多 25 个文件**：选择“分别发布”，批量生成各自的展示页和下载直链；单项失败不影响其他成功结果。
3. 点击 **创建分享 / 批量发布**，跟随三步向导：① 选择分享形式；② 标题/简介；③ 检查警告并明确确认公开。
4. 创建文件夹或合集后获得公开目录页 `/s/odg_<32hex>`。访问者可浏览目录，点击文件“预览”打开 `/s/odf_*`，点击“下载”访问 `/r/odf_*`。
5. 在 **文件夹与合集分享** 标签中修改标题与说明、复制链接或撤销。撤销组会原子停用其所有专属 `odf_*` 文件分享；独立发布的同一个 OneDrive 文件不会被影响。
6. 在 **已发布直链** 中继续管理以前单独发布的文件；这些旧记录与链接保持不变。

## 数据与同步语义

- 文件本体始终在 OneDrive；仅文件夹/文件名、结构、大小、MIME 类型和管理员明确发布的文件 ID 保存至 D1。不默认复制到 R2。
- 本阶段**只实现静态快照**。新加入 OneDrive 文件夹的内容不会自动出现在公开分享中。即使原文件夹改变，也不会静默新增对外授权的文件。自动同步留给 RC14.12 的专门安全和变更检测阶段。
- 单个组最多 **180 个目录项（文件+文件夹）**、最多 **8 层目录**、最多读取 **20 页 Graph 文件夹分页**、一次最多选取 **30 个源项**。超限时不写入任何组或子文件记录。
- 文件原有 ID/微软访问控制可能失效，固定入口仅能保证 CloudDrive URL 不变，不保证 OneDrive 文件永不被删除或被微软限流。
- 文件夹和合集公开列表来自 D1 静态快照，不包含 Microsoft Access Token、Drive ID、Item ID 或预授权的下载 URL。
- 访问链接撤销后，CloudDrive 的 `/r/*` 和 `/api/v1/public/onedrive/*` 将拒绝相关访问。此前由 Microsoft 发出的临时预授权 URL 在到期前可能仍有效，不应把 CloudDrive 的撤销视为即时撤销已获取的微软 URL。

## API 与迁移

| API | 用途 | 权限 |
| --- | --- | --- |
| `POST /api/v1/admin/onedrive/groups` | 创建静态文件夹/合集（`kind`、`title`、`description`、`item_ids`、`confirm_public:true`） | 超级管理员 |
| `GET /api/v1/admin/onedrive/groups` | 列出已创建组 | 超级管理员 |
| `PATCH /api/v1/admin/onedrive/groups/odg_*` | 修改组标题与简介 | 超级管理员 |
| `DELETE /api/v1/admin/onedrive/groups/odg_*` | 撤销组及其专属文件链接 | 超级管理员 |
| `POST /api/v1/admin/onedrive/drive/batch-publish` | 多文件逐项发布，返回每项成功/失败 | 超级管理员 |
| `GET /api/v1/public/onedrive/groups/odg_*` | 获取已发布的静态目录数据 | 公开 |
| `GET /s/odg_*` | 目录/合集浏览页面 | 公开 |

本次新增 D1 迁移：`migrations/0029_rc14_10_onedrive_groups.sql`，创建 `onedrive_share_groups`、`onedrive_share_group_entries` 两表，并为 `onedrive_drive_publications` 增加 `group_id`（可空，不改变旧记录）。

建议部署顺序（先进行 D1 备份）：

```bash
npm run build
npm run db:migrate:remote
npm run deploy
```

`npm run deploy` 如果已有自动迁移步骤，应根据实际脚本提示确认是否重复执行。部署后，先用专用 OneDrive 测试文件夹验证创建、目录导航、预览/下载和撤销。

## 已知限制

- 没有文件夹 ZIP 整包下载：每个文件仍由原有 `/r/odf_*` 独立分发。
- 不支持动态自动纳入新文件、增量同步或大规模后台导入任务；这类能力留待 RC14.12。
- 不会主动创建 OneDrive 原生共享权限，CloudDrive 使用管理员已授权的 Graph 读取能力分发**明确发布**的文件。
- 对于大于上限的文件夹，需拆分目录成多个分享，避免一次 Worker 请求长时间遍历。
- 公开目录页未连接微软真实租户执行端到端测试。模拟的 D1、Graph、R2 和 Worker 集成测试不能替代实际浏览器与微软账号兼容性测试。
