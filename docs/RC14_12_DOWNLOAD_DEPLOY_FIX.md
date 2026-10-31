# CloudDrive RC14.12 — 部署变量、OneDrive 下载和文件夹双击修复

> 本次为 RC14.12 源码热修复。基线必须是 RC14.12，不要把此增量补丁应用到 RC14.11 或更旧版本。

## 1. 为什么 MS_CLIENT_ID 重新部署后消失？

- 如果 `MS_CLIENT_ID` 是 Cloudflare Dashboard → Worker → Settings → Variables and Secrets 中填写的 **Text**（普通文本变量），Wrangler 默认会用 `wrangler.jsonc` 中的 `vars` 覆盖后台变量。原项目未设置 `keep_vars`，部署后可能删除后台 Text 值。
- 此版本在 `wrangler.jsonc` 顶层增加 `"keep_vars": true`，并在 `scripts/deploy-cloudflare.mjs` 生成的临时配置中强制保留它。两次 `wrangler deploy` 都带 `--keep-vars`。当前部署流程仍自动查找原 D1、执行迁移、验证后发布。
- **Secret 类型**的变量按 Cloudflare 设计在正常 Wrangler 部署时不会被删除。如果 Secret 仍然消失，请检查是否部署到了另一个 Worker、账号或环境（Preview / Production），不要误判为 `keep_vars` 问题。
- **不要**把 `MS_CLIENT_SECRET` 或 `MS_TOKEN_KEY` 的值写入公开 `wrangler.jsonc`。已经连接 Microsoft 的站点也不要重新生成 `MS_TOKEN_KEY`，否则旧授权密文会无法解密。

**Cloudflare 操作步骤：**
1. 确认代码中的 `wrangler.jsonc` 的 `name` 与实际网站绑定的 Worker 名称一致，并核查 Git 自动部署的目标账户。
2. 登录 Cloudflare → Workers & Pages → 原 Worker → **Settings → Variables and Secrets**，确认 `MS_CLIENT_ID`、`MS_CLIENT_SECRET`、`MS_TOKEN_KEY` 在**运行时**正确配置，不是只在构建变量中。
3. 使用更新后的源码运行 `npm run build`、`npm run deploy`（Deploy Command 继续使用 `npm run deploy`）。部署脚本会保留网页设置的 Text 变量。
4. 如果以前已被删掉，**需要重新填写一次** `MS_CLIENT_ID`，再部署并检查。`keep_vars` 无法自动找回此前丢失的值。
5. 进入系统设置 → Microsoft OneDrive → “重新检查配置”确认三个变量均为有效。

## 2. 为什么 OneDrive 下载出现 Source temporarily unavailable？

旧版 `worker/services/onedrive-drive-files.js` 把所有下载异常一概转换成英文通用错误，无法识别究竟是授权失效、文件权限不足、限流还是下载地址不可用。还存在一个明确逻辑缺陷：当 Graph `/content` 返回了**不可信的 302 地址**时，服务函数返回的是 `Response` 对象，而调用方把它当作 `{location, response}` 对象访问，导致新的 TypeError 又被统一隐藏。

本版改为：
1. 每次从官方 Microsoft Graph 根据 `drive_id` 和 `item_id` 获取文件元数据，优先显式请求 `@microsoft.graph.downloadUrl`，不将它写入 D1 或长期缓存。
2. 部分微软账号不支持元数据 `$select` 时，尝试普通文件元数据请求。
3. 若文件确实存在但元数据未返回下载地址，则调用授权的 `/content`，使用 `redirect: manual`；仅允许微软已知的 HTTPS 下载目标；若 Graph 直接返回文件字节则 Worker 流式转发。
4. `/content` 请求不携带 `Range`，符合官方文档；如通过 302 跳转到临时 URL，下载器可以使用真实下载地址进行分段请求。临时 URL 不是永久地址，永久的是 CloudDrive `/r/odf_*`。
5. 出错时不计入下载次数，在已发布分享的 `last_error` 中保存**不含 Secret 的错误码**，响应的 `X-CloudDrive-Error-Code` 会显示同一错误码。不会输出微软 Bearer Token、临时下载 URL 或 Graph 响应正文。

| 代码 | 代表问题 | 推荐处理 |
| --- | --- | --- |
| `MICROSOFT_REAUTHORIZE` | Microsoft OAuth 授权无效，令牌续期失败 | 系统设置重新连接 Microsoft 账户；检查 Secret 未发生改变 |
| `MICROSOFT_ACCESS_DENIED` | Graph 403，账号无权下载该文件 | 检查管理员 OneDrive 文件权限、组织共享政策 |
| `MICROSOFT_NOT_FOUND` | Graph 404 或不再是文件 | 检查文件是否删除或更改所有权 |
| `MICROSOFT_THROTTLED` | Graph 429 | 遵循 `Retry-After`，降低检查频率 |
| `MICROSOFT_UPSTREAM_UNAVAILABLE` | Graph 502/503/504 | 稍后重试，检查微软服务状态 |
| `MICROSOFT_DOWNLOAD_REDIRECT_UNTRUSTED` | 下载重定向目标不在安全白名单 | 使用“诊断下载”检查；如微软启用新域名，先核实官方归属再修改代码 |
| `GRAPH_CONTENT_NOT_FILE` | `/content` 返回网页或非预期 JSON，而不是预期的文件流 | 核实权限、账号及文件来源，不要把登录网页当作文件下载 |
| `MICROSOFT_TIMEOUT` | 微软请求超时 | 检查网络和上游状态 |
| `MICROSOFT_GRAPH_FAILED` | 其他 Graph 非成功状态 | 在管理员诊断结果中查看 HTTP 状态；检查 Microsoft Graph 可用性 |

**安全诊断：** 以超级管理员访问 `/onedrive` → **已发布直链** → **诊断下载**；也可在系统设置 Microsoft 账号模块的已发布文件区域找到该按钮。它不使用浏览器带来的 Microsoft Token，不返回临时下载 URL，不扣下载限额。它可以确认 Graph 当前是否给出可用跳转或字节流响应，但不能保证访客网络和后续整个文件传输都顺利完成。

### 仍然存在的上游限制

- 若管理员当前确实没有权限，或 OneDrive 账号被限流，代码不能绕过微软限制。
- 微软临时下载地址会过期，不承诺微软原始 URL 永久有效；`/r/odf_*` 保持地址固定但源文件仍可能失效。
- 大文件流式回退可能占用 Worker 子请求、连接时长与传输资源；建议优先 302，必要时再走流式回退。
- 本地 Graph 模拟测试通过，但**没有连接用户真实微软账号进行端到端下载验证**。如上线后继续失败，请提供 `X-CloudDrive-Error-Code` 或“诊断下载”返回的**代码及 HTTP 状态**，不要提供密钥、授权码、带令牌的微软临时 URL。

## 3. 文件夹双击

- R2 文件管理页面的列表行、网格卡片：双击文件夹的**非按钮区域**进入目录，原有文件夹名称、操作按钮功能保留。
- OneDrive 文件管理页面：双击文件夹卡片、缩略图、名称或列表行打开；键盘焦点在文件夹名称时按 Enter 也能打开。
- 团队空间的目录列表和公开 OneDrive 文件夹/合集分享页也支持双击非按钮区域。
- 双击删除、复制、权限、下载、勾选框等操作控件不会触发目录导航；手机触屏端继续使用“打开”按钮。

## 4. 升级和回归

- 将补丁覆盖到 **RC14.12 原源码**。生产环境请保留你的 `wrangler.jsonc` 中账号专属 Worker 名称、D1/R2 桶名、域名等配置，只合并 `keep_vars` 项及部署脚本改动；不要覆盖线上实际 Secret。
- 执行 `npm run build` 后通过 `npm run deploy` 更新原 Worker。**本补丁不增加数据库迁移，不需要重新连接 OneDrive**（前提是原加密密钥与授权仍然有效）。
- 部署后核验 Dashboard 的 MS_CLIENT_ID 保留、Microsoft 连接状态、OneDrive 真实文件的 `/s/odf_*` 和 `/r/odf_*`、大文件及浏览器分段下载、密码与下载次数限制，以及 R2/OneDrive 的双击文件夹。

参考：
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/workers/wrangler/commands/workers/
- https://learn.microsoft.com/en-us/graph/api/driveitem-get-content
