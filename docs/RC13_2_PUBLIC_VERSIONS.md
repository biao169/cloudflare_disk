# CloudDrive RC13.2 — 永久直链版本化、/r/* 与公开副本同步

> 适用范围：RC13.1 → RC13.2 增量升级。**不重建**现有 Worker、D1 或 R2，不更换任何文件 ID、私密分享令牌和已发出的 `/p/*`、`/published/*` 地址。基于 Workers Free 的轻量原生 JavaScript 架构。

## 一、访问模式

| 地址 | 行为 | 缓存策略 |
|---|---|---|
| `/r/{publicationId}` | 新默认智能永久链接：D1 主库读取当前发布指针；有 PUBLIC_BASE_URL 则 302 到最新公开对象，否则流式返回 R2 内容 | `no-store`，不得启用 Cache Everything |
| `/p/{publicationId}` | 旧 Worker 公开链接，仍使用当前公开对象 | Worker `no-store` |
| `https://cdn.example.com/versions/{publicationId}/v{revision}/{objectId}` | 版本化、不可变的公开 R2 对象；每次更新都换 Key | R2 `Cache-Control: public, max-age=31536000, immutable`；CDN 可选 Cache Rules |
| `https://cdn.example.com/published/{legacyId}` | RC13.1 及更早直接发出的 CDN URL；继续保留 Key，更新文件后通过异步兼容任务覆盖该 Key，并尝试 Purge | R2 设置短缓存；**不能承诺实时全球更新** |

**新建永久发布 API 的 `url` 现在默认返回 `/r/{id}`。** 旧的 CDN 直达地址仍可在 `legacy_url` 字段取得；此前对外发出的旧地址不会因升级被修改。

注意：首次发布为减少 R2 占用仍沿用 `published/` Key；首次覆盖后会生成 `versions/` 中的不可变对象，新请求自动切到新 Key。`/r/` 在每次新请求时重新解析 D1 最新已提交的公开版本；它不会使已打开的网页、已开始的下载或第三方浏览器缓存立即改变。

## 二、公开版本的更新事务

1. 普通上传或 Multipart 先写入新的**私有** R2 Key，校验字节数。
2. 若该文件拥有 `status=ready` 且 `auto_sync=1` 的公开发布，先预留“新公开对象 + 旧 CDN 兼容地址可能增长”的空间额度。
3. 向 `PUBLIC_BUCKET` 写入 `versions/{publicationId}/v{revision}/{随机 UUID}`，确认对象大小匹配。
4. 在同一 D1 `batch()` 中对 `files.revision` 执行乐观并发条件更新，并同步切换 `publications.public_object_id`、`published_revision`、插入 `publication_versions`、持久化旧 CDN URL 更新任务及提交容量账本。
5. 只有 D1 条件提交成功，新的 `/r/` 才指向新版本；失败则保留旧发布，尝试删除新建的阶段性公开对象。R2 删除失败时记录持久化清理任务。
6. 更新已发出的 `published/*` 原地址：从新版本对象流式复制；成功后同步大小和配额，再对旧直连 URL 请求 CDN 单 URL 缓存清理。若失败，Cron 或管理员 API 重试。**旧直连缓存同步与 /r 当前版本相互独立。**

替换后 `files.id` 和所有私密分享地址仍不变；历史版本恢复、分片替换同样触发公开新版准备和切换。已撤销公开发布不随文件替换自动恢复。

### 空间配额

R2 占用会同时计入旧私有修订、新私有修订、公开不可变版本和兼容的公开别名。更新前需要足够容量同时容纳新旧内容；容量不足则返回 `PUBLIC_QUOTA_EXCEEDED`，旧文件和旧发布不变。

**技术边界：** RC13.2 的单次公开复制采用 R2 Worker `get()` 流式传输 → `put()`，因此单对象上限为 R2 非 Multipart 单次复制的 4.995 GiB。更大的文件如果已有自动公开发布，会在开始分片替换前返回 `413 PUBLIC_COPY_TOO_LARGE`，不会删除旧版本。后续版本可添加 Durable Object / Cron 驱动的分片公开复制任务。

### 自动清理

旧的不可变公开版本保留**最近一个上一版本**；更早对象至少保留 48 小时。之后 Cron 小批量将历史引用移除并转入 R2 持久化删除队列，确认删除成功才扣减已用容量。**原始 `published/*` 兼容 Key 不纳入该自动版本清理**。

## 三、公开 CDN 的控制台配置

首次使用智能 CDN 的前提：在 Cloudflare R2 `clouddrive-public`（不是 `clouddrive-private`）的 Settings → Custom Domains 绑定 HTTPS 子域名，例如 `cdn.example.com`。设置 Worker 运行时公开文本变量或已有 `wrangler.jsonc` 的 `PUBLIC_BASE_URL=https://cdn.example.com`，**不能带路径和查询参数**。

Cloudflare Cache Rules 建议：

- 网盘 Worker 域名下 `URI Path starts with /r/` 和 `/p/`：**Bypass Cache**，保证 Workers 脚本实际执行。`/r` 的 302 响应也显式使用 `no-store`；禁止 301/308 永久重定向。
- 公开 CDN 域名下 `URI Path starts with /versions/`：可设置 Eligible for cache，使用较长的 Edge TTL。每个版本 Key 只写一次，适合长期缓存。
- 公开 CDN 域名下 `URI Path starts with /published/`：建议 Bypass Cache / 短 TTL；若已有历史强制缓存设置，必须配置 API 清理并接受传播与浏览器缓存滞后。

可选运行时配置：`CDN_ZONE_ID`（域名所在 Zone 的 32 位十六进制 ID）和 Secret `CDN_PURGE_TOKEN`（仅授予对应 Zone 的 Cache Purge 权限）。不配置不会影响 `/r/` 新版本解析，但旧直接 CDN URL 的缓存状态会显示 `cache_unverified`，而不谎称全部刷新成功。

已经复制或嵌入的历史 `versions/*` 地址属于公开文件，即使撤销发布，访问者已有副本或 CDN 缓存仍可能短期保留。严禁对需要密码、限时、精确撤销的资料创建永久公开 CDN 发布。

## 四、新增或扩展接口

- `GET /r/{publicationId}` / `HEAD /r/{publicationId}`：公开智能永久入口，无需登录。
- `GET /api/v1/publications/{id}/status`：管理员查看 `published_revision`、`sync_state`、`smart_url`。
- `GET /api/v1/publications/{id}/versions`：管理员查看已记录的公开修订号。
- `POST /api/v1/publications/{id}/sync`：管理员重试 `published/*` 旧别名同步或缓存清理。所有写操作仍受原有同源/CSRF 校验。
- `GET /api/v1/publications`：现有列表增加 `smart_url`、`legacy_url`、`published_revision`、`sync_state`。**`url` 默认改为智能地址**。

同步状态：`ready` 表示应用记录及需要的缓存清理已完成或无独立 CDN；`alias_pending` 表示旧 URL 对象尚待同步；`purge_pending` 表示旧对象已更新、缓存清理待重试；`cache_unverified` 表示旧对象已更新但 CDN 清理未配置或未能验证。`/r/` 不依赖旧别名同步结果。

## 五、GitHub 自动部署与生产安全

- Build Command：`npm run build`
- Deploy Command：`npm run deploy`
- Worker 名称、原 D1/R2 绑定、`SHARE_LINK_KEY`、`BOOTSTRAP_TOKEN`、CDN 自定义域名不变。
- 迁移文件：`migrations/0020_rc13_2_public_versions.sql`。只新增列、索引、发布修订/同步任务表，并为旧发布补齐 `legacy_object_id`。不会删除任何旧公开文件或分享。
- **增量补丁脚本会单独为原有 `wrangler.jsonc` 的 `assets.run_worker_first` 增加 `/r/*`，且不覆盖其他自定义生产配置。** 不执行这项路由配置会导致 `/r/` 可能被 SPA 静态资源路由拦截。

生产直接部署前应使用既有 Windows 运维脚本备份 D1 与两个 R2 Bucket。仅回滚 Worker 代码不会回滚 D1 的新增迁移，也不会自动删除已发布的不可变 R2 对象。

验证方法：创建或使用一个公开文件 → 复制 `/r/{id}` → 覆盖同一逻辑文件 → 检查 `/r/{id}` 是否 302 到 `versions/*/v2/*`（无 CDN 域名则 200 返回最新 R2 内容）→ 原 `/p/{id}` 仍指向新版 → 查看旧 `published/*` 的同步状态。检查响应中 `Cache-Control: no-store`，不要把 HTML 页面 200 误当成 `/r/` 成功。

## 六、已知边界

1. 暂不支持超过 R2 单次复制上限的**自动公开版本化更新**，但不影响正常私密大文件 Multipart 上传。
2. CDN 旧别名刷新依赖 API Token、Cloudflare Cache Rules 和浏览器缓存行为，不能保证已分发原始 CDN URL 的全球瞬时更新；推荐推广 `/r/{id}`。
3. D1 与 R2 无跨服务原子事务；发布准备 + D1 原子指针 + 后续 outbox 清理能降低失败影响，但生产上仍需关注 Workers Logs 和运维面板。
4. RC13.1 的私有历史版本目前仍需要单独的保留策略；RC13.2 本次只加入公开不可变版本清理。
5. 目前完成的是 Node + SQLite + 模拟 R2 级别自动化验证；Cloudflare 真正部署及浏览器 CDN 一致性需要上线后只读检查。
