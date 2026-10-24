# RC5：Cloudflare Workers Builds 自动部署与 D1 自动迁移

## 修复的真实问题

1. RC3/RC4 在 `wrangler.jsonc` 中省略 `database_id`，可以利用 Wrangler 自动创建 D1，却导致 `wrangler d1 migrations ... --remote` 在部分 Wrangler 版本报“missing database_id”。旧的自动部署把 `migrations list` 的任何失败当作尚未创建数据库，可能重新部署却无法完成迁移。
2. `0001_initial.sql` 中存在 `PRAGMA foreign_keys = ON;`，而 Cloudflare D1 的外键始终开启、每次查询会处于隐式事务中，不允许用这个 PRAGMA 更改执行方式。
3. `scripts/deploy.bat` 和 `.github/workflows/deploy.yml` 原来调用裸 `wrangler deploy`，忽略数据库迁移。
4. 当前线上 Worker 实际名为 `cloudflare-disk`，旧模板配置名 `clouddrive` 存在部署到其他实例的风险。

官方文档：
- <https://developers.cloudflare.com/workers/platform/deploy-buttons/>
- <https://developers.cloudflare.com/d1/sql-api/foreign-keys/>
- <https://github.com/cloudflare/workers-sdk/issues/13632>
- <https://developers.cloudflare.com/workers/ci-cd/builds/configuration/>

## RC5 的自动部署算法

```text
npm run deploy
  |
  +-- 读取 wrangler.jsonc，并检查 Worker name / D1 / R2 绑定
  |
  +-- wrangler d1 list --json
      |-- 网络/权限/格式错误 -> 失败并停止；不会误创建新 D1
      |-- 找到唯一 clouddrive-db -> 从返回的 uuid 生成临时 config
      |     |-- d1 migrations apply DB --remote --config 临时配置
      |     |-- SELECT sqlite_master 检查所有必需表与 d1_migrations
      |     +-- wrangler deploy --config 临时配置
      |-- 未找到（全新账户）
            |-- wrangler deploy，自动创建 D1/R2
            |-- 再次列出 D1，确认已创建并获取 uuid
            |-- 生成带 uuid 的临时 config
            |-- d1 migrations apply DB --remote
            |-- 验证表结构
            +-- 最终 wrangler deploy（显式绑定到刚创建的 D1）
  |
  +-- 删除临时 config，不把 uuid 写入 Git
```

**安全原则：** 当列表查询失败、D1 名称不符、ID 与配置冲突或迁移失败，直接退出非零状态，不执行后续发布。`--upgrade` 不允许首次创建 D1；`--migrate-only` 不更新 Worker；所有 D1 增量迁移通过 Cloudflare 自身的迁移 ledger 管理。Wrangler 官方会在运行迁移时保存备份，正式重要升级仍应安排持久备份。

## Cloudflare Dashboard 设置（只需一次）

| 选项 | 值 |
|---|---|
| Repository | `biao169/cloudflare_disk` |
| Branch | `main` |
| Root Directory | `/` |
| Build Command | `npm run build`（测试，无前端编译） |
| Deploy Command | **`npm run deploy`** |
| Worker name | `cloudflare-disk`（与已上线的 Worker 一致） |
| Runtime Secret | `BOOTSTRAP_TOKEN`，随机至少 32 字符 |

**注意：** Worker 的构建设置与 GitHub 仓库中的代码是两个独立来源。已经创建的 Worker 需要在 Dashboard 手动修改并保存 Deploy Command 一次，之后每次推送 main 会使用它。Cloudflare 自动创建的构建 API Token 须有 D1 列表、迁移和 Worker 部署权限；权限不足将被脚本明确识别为失败。

## 失败场景与处置

- `Found a database ... missing database_id`：通常是未使用本版 `npm run deploy`，检查日志中自动获取 D1 ID 的步骤。
- `Access denied` / D1 List 失败：检查 Cloudflare Builds 的 API Token 权限、Cloudflare Account ID 和项目绑定；**不要**用“创建新 D1”绕过。
- 数据库迁移失败：阅读详细 Wrangler 日志；如果出现在 `0001_initial.sql` 的 `PRAGMA foreign_keys`，确认仓库已包含 RC5 修复。
- `Worker already exists`：检查 `wrangler.jsonc.name` 是否与你在 Cloudflare 已创建的 Worker 名称一致。用户当前应为 `cloudflare-disk`。
- `D1_MIGRATIONS_REQUIRED`：检查是否已经推送 RC5、Cloudflare 实际 Deploy Command 是否仍是裸 `wrangler deploy`，以及 D1 迁移日志。
- `BOOTSTRAP_SECRET_REQUIRED`：D1 已就绪，下一步只需设置 Worker 运行时 Secret，不要重新建表。
- `ADMIN_SETUP_REQUIRED`：访问 `/setup` 输入管理员用户名、密码和初始化令牌。
- `READY`：管理员和基础数据库已就绪；继续做生产浏览器测试。

## Windows 本地运维指令

```powershell
npm install
npm run db:migrate:local
npm run dev
npm run build

# 需要 Cloudflare 身份认证，执行前明确确认生产账户
npm run db:migrations:list:remote
npm run db:backup:remote
npm run db:migrate:remote
npm run deploy
```

Windows 快捷脚本 `scripts\deploy.bat`、`scripts\migrate-remote.bat`、`scripts\backup-remote-db.bat` 已改用统一的 RC5 自动解析 ID 功能。

> RC5 仍属于发布候选版。本地 `node:sqlite` + 模拟 R2 测试无法代替正式的 Wrangler / Cloudflare 真实账户测试。生产 D1/R2 数据请在变更前备份。
