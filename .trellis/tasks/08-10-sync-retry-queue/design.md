# 设计：待同步项目可恢复化

## 数据流

```text
IndexedDB cloud_outbox（当前 ownerId）
  -> readCloudOutbox(ownerId)
  -> cloudPendingItems + cloudPendingCount
  -> 设置页待同步列表
  -> 单项重试（playlistId 过滤）/ 全部重试
  -> 现有 performCloudSync 决策与 acknowledge 流程
```

## 展示边界

- 已登录：只读取当前 `cloudUserId` 的 outbox；每行使用 outbox 中已脱敏的 `playlist.name`、歌曲数量、`operation`、`updatedAt`。
- 未登录：仍可保留总数提示，但不展示任何歌单名称；提示登录对应账号后查看和继续同步，避免账号之间的信息泄露。
- 永久删除 outbox 没有歌单快照时，使用安全的 `playlistId` 作为回退标题，不读取或展示完整对象。

## 重试实现

- `performCloudSync(reason, options)` 接受可选 `playlistId`，构建完整本地/远端快照后只处理目标 id；其他 id 不进入决策循环。
- `retryCloudOutboxItem(id)` 校验当前账号和在线状态，按 outbox 的 `playlistId` 调用单项同步。
- `retryAllCloudOutbox()` 调用现有全量同步；不修改 outbox 记录，不绕过冲突和版本检查。
- 每次重试结束都重新读取 outbox，刷新列表和数量；失败记录仍由 `setCloudState('error')` 写入 `cp_cloud_last_error`。

## 健康检查复用

- `inspectCloudHealth()` 读取当前内存中的 `cloudLastErrorMessage`（该值由 `readCloudLastError()` 或 `rememberCloudSyncError()` 产生）。
- 健康项目和 `sanitizeCloudHealthReport()` 只带这份脱敏文本的 `lastError` 字段，不读取原始异常对象。

## 兼容与缓存

- 只修改 `index.html`、`js/app.js` 和浏览器测试；因此递增 `sw.js` 缓存版本。
- `cloud_outbox` 结构保持兼容，旧记录仍可按 `playlistId` 回退展示。
