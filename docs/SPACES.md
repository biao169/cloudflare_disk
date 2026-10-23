# 第四阶段：空间、成员、目录权限

## 模型

- 每个用户恰好一个个人空间（通过部分唯一索引强制）；管理员初始化、创建用户、登录时按需建立。
- 团队空间由超级管理员创建，空间 owner、超级管理员或 admin 成员拥有空间管理权限。
- `space_members.role`: `admin`、`editor`、`viewer`；基础权限分别为全部、读写删分享、只读。
- `folder_permissions.permission_mask`：读=1、写=2、删除=4、分享=8、管理=16。目录 ACL 从子目录向父目录寻找最近的匹配记录，同层用户覆盖优先于角色覆盖。空间管理员不受目录 ACL 的限制。
- 成员从团队移除后，API 下一次授权计算即时失效；已有浏览器数据不能远程抹除。

## API

| 请求 | 功能 | 权限 |
|---|---|---|
| `GET /api/v1/spaces` | 已授权空间（同时自动修复旧账号个人空间） | 登录 |
| `POST /api/v1/spaces` | 创建团队空间 `{name}` | 超级管理员 |
| `GET /api/v1/spaces/:id` | 空间详情 | 空间成员 |
| `PATCH /api/v1/spaces/:id` | 重命名 `{name}` | 空间管理员 |
| `GET /api/v1/spaces/:id/members` | 查询成员 | 空间管理员 |
| `GET /api/v1/spaces/:id/candidates?q=xx` | 按用户名检索可邀请账号（不含密码、邮箱） | 空间管理员 |
| `PUT /api/v1/spaces/:id/members/:userId` | 添加/变更成员 `{role}` | 空间管理员 |
| `DELETE /api/v1/spaces/:id/members/:userId` | 移除成员 | 空间管理员，不能删除 owner |
| `GET /api/v1/spaces/:id/contents?parent_id=` | 授权目录列表（暂不提供真实文件列表） | 具有读取权限 |
| `POST /api/v1/folders` | 创建文件夹 `{space_id,parent_id,name}` | 可编辑成员 |
| `GET /api/v1/folders/:id/permissions` | 查看显式 ACL | 空间管理员 |
| `PUT /api/v1/folders/:id/permissions` | 覆盖 ACL `{principal_type,principal_id,permission_mask}` | 空间管理员 |

## 限制与后续

此阶段的 D1 `folders` 是真实目录记录，但现阶段尚不支持文件移动/删除，亦无真实 R2 对象。目录权限针对读和创建目录已生效，后续文件 API 需要复用相同的权限服务。管理员页面中空间成员可直接按用户名添加。

如已有第三阶段本地数据库，运行 `npm run db:migrate:local` 即可执行新增迁移 `0005_spaces.sql`，无需清库。SQLite 与 D1 对账号的个人空间采用惰性补全。测试环境和正式环境隔离，切勿在未备份的生产数据库执行手动 SQL。
