# 研究记录：同步健康检查的新鲜待办状态

## 证据

- `inspectIndexedDbHealth()` 在 `js/app.js` 5175 行附近直接读取 `cloud_outbox` 并返回数量。
- `inspectCloudHealth()` 在同一流程中读取全局 `cloudPendingCount`，该值由异步 `refreshCloudPendingCount()` 更新，存在时间窗口。
- `runCloudHealthCheck()` 当前先得到 IndexedDB 项，再同步调用云同步项，因此可安全传递前者的数量，不需要额外网络请求。
- 现有健康检查只覆盖空 outbox；缺少“检查开始后新写入一项待办”的回归。

## 假设

如果在页面启动后的异步投影刷新完成后再写入一条 `cloud_outbox`，立即运行检查，当前实现会显示数据库项为 1 但云同步项仍按 0 计算；让云同步项复用 IndexedDB 数量即可稳定修复。

## 复现与确认

- 修改前桌面回归实际得到：`检查完成：4 项通过，0 项需留意，0 项受阻。`，而数据库检查项已显示 `待同步 1 项`。
- 修改后同一用例在桌面和手机均得到 `1 项需留意`，云同步项包含 `1 项`，且存储指纹未变化。
