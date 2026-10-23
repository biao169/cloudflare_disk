# 项目架构

浏览器：`public/` 原生 ES Modules + Bootstrap，所有静态文件直接交由 Workers Static Assets 分发。

Worker：`worker/index.js` 统一请求入口；`worker/router.js` 提供 `/api/v1/health` 与未来 API 的入口。`/s/*` 交由 `share.html`，`/t/*` 阶段 1 返回 501。

后续：D1 保存账号、空间、文件和分享元数据；R2 分为 private/public 两个桶；浏览器不直接访问私有 R2。

生产数据不得在本地测试阶段接入。
