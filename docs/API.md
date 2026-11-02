# API 接口与函数用法

## 约定

API 前缀为 `/api/v1`，普通请求使用 Cookie 会话认证，管理员接口要求 `super_admin`，写操作需要正确的同源/CSRF 条件。成功与失败分别采用 `{"success":true,"data":...}` 与 `{"success":false,"error":{"code":"...","message":"..."}}`。文件下载可能直接返回流或 302，不是 JSON。

## 常用接口

| 方法与路径 | 功能 | 访问权限 |
| --- | --- | --- |
| `GET /api/v1/health` | Worker 基础状态 | 公开 |
| `GET /api/v1/health/ready` | 绑定、迁移及初始化检查 | 公开 |
| `GET /api/v1/spaces` | 当前用户的空间 | 已登录 |
| `GET /api/v1/spaces/{spaceId}/contents?parent_id=&offset=0&limit=50` | 当前文件夹文件与子文件夹列表 | 空间 ACL |
| `GET /api/v1/spaces/{spaceId}/folders?parent_id=&offset=0&limit=50` | 多级文件夹导航 | 空间 ACL |
| `GET /api/v1/files/recent` | 最近文件 | 已登录 |
| `GET /api/v1/search/global` | 跨授权空间搜索 | 已登录 |
| `POST /api/v1/files/batch` | 批量复制/移动 | 对象写权限 |
| `GET /api/v1/files/{fileId}/content` | 下载文件 | 对象读权限 |
| `GET /api/v1/files/{fileId}/preview` | 文件预览 | 对象读权限 |
| `GET /api/v1/shares`、`POST /api/v1/shares` | 查询或创建分享 | 已登录且有权限 |
| `GET /api/v1/shares/{id}/link` | 找回可解密的分享地址 | 分享所有者 |
| `PATCH /api/v1/shares/{id}` | 更新分享属性 | 分享所有者 |
| `POST /api/v1/tools/onedrive/resolve` | OneDrive 链接解析 | 取决于匿名开关/配额 |
| `GET /api/v1/admin/onedrive/drive/items` | 浏览管理员 OneDrive | 超级管理员 |
| `POST /api/v1/admin/onedrive/drive/publish` | 确认发布 OneDrive 文件 | 超级管理员 |
| `GET /api/v1/admin/onedrive/drive/publications` | OneDrive 已发布列表 | 超级管理员 |
| `GET /api/v1/admin/dashboard` | 容量与运行信息 | 超级管理员 |
| `POST /api/v1/admin/maintenance/run` | 手动维护 | 超级管理员 |

## curl 示例

```bash
# 无须登录：检查服务绑定、初始管理员及 D1 表状态
curl -fsS https://your-domain.example/api/v1/health/ready

# 浏览器登录后通过同源请求读取某个文件夹（占位 ID）
# 以下只展示接口路径；具体请求必须附带有效 Cookie
curl -b cookies.txt 'https://your-domain.example/api/v1/spaces/SPACE_UUID/contents?parent_id=&offset=0&limit=50'
```

不要在公开命令、截图或 issue 中包含真实 Cookie、Share Token、MS Access Token 或敏感下载地址。完整后端路由可查看 `worker/router.js` 与 `worker/api/`，OneDrive 分发在 `worker/services/`。
