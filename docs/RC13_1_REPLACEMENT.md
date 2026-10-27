# CloudDrive RC13.1 — 安全替换与逻辑文件版本

## 新功能

- 在同一目录上传同名文件时，提供覆盖、重命名、跳过选择。覆盖会保留 `files.id` 及现有私密分享记录；不自动恢复已撤销或过期分享。
- 无论普通上传还是 R2 Multipart 上传，都需要明确的 `replace_file_id` 与 `expected_revision`，并校验名称、所属空间、目录与当前写权限。
- 每次替换都写入独立随机 R2 Key，不直接覆盖旧存储对象；在 D1 事务中新增版本记录并以修订号条件更新文件指针，防止并发编辑静默覆盖。
- `GET /api/v1/files/{id}/versions` 可查看历史修订；`POST /api/v1/files/{id}/versions/{rev}/restore` 将指定版本重新设为当前版本，并产生新修订号，不变更文件 ID。
- 新增迁移 `0019_rc13_file_versions.sql`，不删除旧账号、分享或对象数据。

## API

| 方法 | 地址 | 用途 |
|---|---|---|
| GET | `/api/v1/files/:id/replacement-target` | 查看待替换对象及当前修订号（需写权限） |
| GET | `/api/v1/files/:id/versions` | 当前修订号与历史版本（需写权限） |
| POST | `/api/v1/files/:id/versions/:revision/restore` | 恢复历史版本，当前修订号增加一 |
| POST | `/api/v1/storage/upload?space_id=...&name=...&replace_file_id=...&expected_revision=...` | 小文件安全替换（仍限制 8 MiB） |
| POST | `/api/v1/uploads` | 大文件上传初始化 JSON 增加 `replace_file_id`、`expected_revision` |

## 设计边界和上线注意事项

1. 本次只保证**私有临时直链及文件分享页面**读取最新的逻辑文件内容。永久公开 R2/CDN 副本尚不会自动同步；该能力留给 RC13.2，且必须单独处理缓存。
2. 历史对象会保留并占用 R2 物理空间。本阶段暂不自动清理历史版本。后续应实现含物理引用计数、可配置保留期、配额核算的版本淘汰任务。空间不足时安全拒绝替换，不会先删除旧对象。
3. 恢复旧版本并不会撤销主动禁用、过期或权限变化后的分享。
4. 由于已有分享文件的名称/目录可能变化，替换请求必须与现有文件的名称、空间及目录精确对应。
5. 文件夹合并/镜像替换、文本在线编辑、全球 CDN 版本化同步安排在后续 RC13.2–RC13.4。
6. 部署前建议备份 D1 和关键 R2 对象；构建配置继续为 `npm run build`、`npm run deploy`，迁移后发布现有 Worker。

## 测试范围

新增集成测试覆盖：小文件替换后临时分享内容更新、稳定 ID 与历史记录、旧修订冲突、跨用户权限拒绝、R2 Multipart 大文件替换与历史恢复。已有自动化测试也应全量运行。此次不会直接访问生产 Cloudflare 账户。
