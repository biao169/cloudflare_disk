# Stage 6 — R2 文件内容存储

- `PRIVATE_BUCKET` 使用私有 R2。`PUBLIC_BUCKET` 仅预留绑定；公开资源发布属于第八阶段。
- 原生上传接口：`POST /api/v1/storage/upload?space_id=<uuid>&folder_id=<uuid>&name=<encoded filename>`，body 为文件字节流，需提供准确的 `Content-Length`。一次最多 8 MiB。浏览器 Fetch 为 Blob/File 自动产生长度。
- 已登录和有写权限的用户方可上传，服务端检查同名文件、空间配额。空间计数预留采用 D1 条件更新。成功后，R2 对象与 D1 元数据同步关联；失败时尽力删除对象并释放预留。
- 下载：`GET /api/v1/files/<uuid>/content`，同时支持 `HEAD` 和单个 `Range` 请求，私有文件必须逐次鉴权。下载默认 `attachment`，第八阶段再增加预览内联模式。
- 普通下载使用 fetch/blob 以兼容现有界面，不适合大文件；第七/八阶段应改为基于受保护 URL 的浏览器原生下载和媒体 Range。
- 同一存储对象可能被多个逻辑文件复制引用，因此清理对象时必须检查是否仍被其他文件引用。第六阶段不提供物理删除接口。
- Worker 与 R2 存储操作无法跨服务原子提交；极端情况下可能遗留孤儿对象，后续阶段必须加入定时核查和修复。
- 公开桶禁止把私有文件作为公开对象托管；用户上传的对象始终写入 PRIVATE_BUCKET。
- 大文件分片上传、续传、取消以及配额再同步归属于第七阶段。
