# 研究：同步失败可恢复化——最近错误持久化

## 现状证据

- `js/app.js` 的 `cloudLastErrorMessage` 是模块内存变量，刷新页面后恢复为空。
- 设置页已有 `#cloudLastError`，`setCloudState('error', ...)` 会显示“最近错误”，同步成功会隐藏；无需新增 UI。
- `CLOUD_LAST_SUCCESS_KEY`、`readCloudLastSuccessfulAt()`、`rememberCloudSyncSuccess()` 已提供按 owner 绑定本机同步状态的模式，可沿用同样的安全存储封装。
- `handleCloudSession()` 已在会话恢复和账号切换时集中更新 `cloudUserId`，是读取错误记录的唯一合适入口。
- `syncCloudPlaylists()` 的异常出口统一调用 `setCloudState('error', ...)`，因此在状态中心持久化即可覆盖自动同步和手动重试失败。

## 方案取舍

- 使用单个本机 JSON 记录 `{ ownerId, at, message }`，与现有最近成功记录保持一致，避免为短提示引入 IndexedDB 迁移。
- 只持久化脱敏后的用户提示，不序列化原始错误对象，降低日志和本机存储泄露风险。
- 账号不匹配时只忽略当前展示，不把其他账号文本复制到内存；当前账号的新错误会覆盖该槽位，后续如需多账号历史再单独设计。\n
