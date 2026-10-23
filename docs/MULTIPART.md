# 第七阶段：R2 Multipart 分片上传

## 接口

- `POST /api/v1/uploads`：JSON `{name,space_id,folder_id,size_bytes,mime_type}`，创建会话并预留存储空间
- `GET /api/v1/uploads`：当前登录用户的进行中任务
- `GET /api/v1/uploads/:id`：查询当前进度和已成功分片
- `PUT /api/v1/uploads/:id/parts/:number`：发送原始分片二进制数据
- `POST /api/v1/uploads/:id/complete`：按顺序合并并登记文件
- `DELETE /api/v1/uploads/:id`：终止分片任务并释放空间预留

所有接口必须登录；修改接口要求与当前页面同源的 Origin 或 Referer。

## 运行

Windows PowerShell：

```powershell
npm install
npm run db:migrate:local
npm run dev
```

访问 `http://localhost:8787/files`，选择文件。文件大于 8 MiB 时自动调用分片 API，默认每片 8 MiB、并发 3 个。任务 ID 暂存本地 localStorage；页面关闭后需要重新选择名称、大小、修改时间相同的原文件才能继续；浏览器不会持续保有本地文件读取权限。临时状态并不代表已经上传完成。

## 目前限制与注意

- 为避免免费额度失控，单文件应用限制 8 GiB；R2 自身允许更大的对象。
- 前端当前同一文件管理视图仅显示一个分片任务面板；多文件会按顺序上传。
- 完成合并与写入 D1 并非跨服务事务；异常时会标记 `failed`，需要人工或后续维护任务核对，不能简单重新合并。
- 默认会话过期 24 小时，Cron 每天清理一次；开发时可手动删除已过期会话。
- 未实现对象 orphan 自动修复、精确断点内容哈希校验、后台持续上传和高并发抢占控制。
- `localStorage` 仅存上传会话 ID，无认证凭证或文件内容。
- 本次 Node 测试不等同于真实 Windows Wrangler/R2 浏览器端到端验证。
