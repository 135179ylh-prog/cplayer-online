# 研究：同步健康检查快照过期提示

## 现状证据

- `runCloudHealthCheck()` 已从同一次 IndexedDB 读取 `cloud_outbox`，但生成的 `cloudHealthSnapshot` 只保存在内存中。
- 本机编辑会进入 `setCloudState('pending', ...)`，同步完成会进入 `setCloudState('synced', ...)`；这些变化不会提醒已展示的健康报告。
- `exportCloudHealthReport()` 只检查是否有快照，因此用户可以把旧报告当成当前状态导出。

## 方案取舍

- 采用单调的内存修订号，而不是把健康快照写入 localStorage/IndexedDB，保持健康检查只读且不增加敏感数据持久化。
- 保留旧结果并标记过期，便于用户看到变化前的证据；重新检查后才恢复导出。
- 只在已有快照时更新提示，避免启动阶段和正常同步过程增加额外 UI 噪音。
