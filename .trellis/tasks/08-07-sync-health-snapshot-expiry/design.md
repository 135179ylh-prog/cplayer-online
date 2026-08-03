# 设计：同步健康检查快照过期提示

## 数据流

```text
云同步/待办状态变化
  -> cloudHealthRevision + 1
  -> 已存在的 health snapshot 标记为 stale
  -> 提示重新检查，禁用旧报告导出

runCloudHealthCheck()
  -> 同一次 IndexedDB 只读快照
  -> 保存 snapshot.revision
  -> 清除 stale 提示并恢复导出
```

## 状态规则

- 快照生成时保存 `cloudHealthRevision`。
- `setCloudState`、待同步数量刷新、冲突或成功同步变化会推进修订号。
- `snapshot.revision !== cloudHealthRevision` 即为过期；不删除旧列表，不把旧数据伪装成新数据。
- 过期只影响健康检查展示和导出按钮，不影响播放器、队列或同步本身。

## UI

- `#cloudHealthCheckFreshness` 使用现有状态区域样式和 `aria-live="polite"`。
- 新鲜快照隐藏提示并启用“导出脱敏诊断报告”。
- 过期快照显示“本机状态已变化，请重新检查后再导出报告”，禁用导出按钮。
