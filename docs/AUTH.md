# Stage 3 认证和管理接口

- `GET /api/v1/auth/setup-status`：检测是否有用户。
- `POST /api/v1/auth/setup`：`{username,password,bootstrap_token}`，仅空库且持有环境 Secret 可初始化。
- `POST /api/v1/auth/login`：`{username,password}`，写入 7 日 HttpOnly Cookie。
- `GET /api/v1/auth/me`：返回当前用户的安全字段。
- `POST /api/v1/auth/logout`：撤销当前会话。
- `POST /api/v1/auth/password`：`{current_password,new_password}`，修改后撤销所有会话。
- `GET /api/v1/users`：管理员获取最多 100 个用户。
- `POST /api/v1/users`：管理员创建用户，`{username,password,role}`。
- `PATCH /api/v1/users/:id`：管理员修改 `{role,status}`。

所有写请求需要同源 Origin / Referer 校验。本阶段已实现基础成员管理页面（创建账号、列出成员、启用/停用），角色变更可通过 API 执行；团队共享空间将在下一阶段开发。登录密码长度 6–128 字符。密码 PBKDF2 SHA-256 迭代 100000，需在真实 Workers Free 环境验证 10ms CPU 预算，超限时不能简单降低密码哈希安全强度，应调整认证方式（例如使用 Cloudflare Access）。

生产环境必须在 Workers Secrets 中设置 `BOOTSTRAP_TOKEN`，完成首次初始化后删除 Secret 或旋转，不允许将其写入 `vars` 或 Git。之前的本地演示用户可能有不可用于登录的散列，若已执行 Stage2 seed，请使用全新本地 D1 状态或移除演示用户后初始化。
