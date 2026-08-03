# 设计：同步健康检查的新鲜待办状态

## 根因

`inspectIndexedDbHealth()` 会直接读取 `cloud_outbox`，但 `inspectCloudHealth()` 使用异步刷新前的全局 `cloudPendingCount`。两者在同一次检查中可能不一致，导致摘要把仍有待办的本机状态显示为全部通过。

## 数据流

```text
runCloudHealthCheck()
  -> inspectIndexedDbHealth() 只读读取 DB 与 cloud_outbox
  -> inspectCloudHealth(indexedDb.pendingCount)
  -> 以同一数量生成云同步状态与脱敏报告
```

## 状态规则

- 未配置/未登录：没有待办为 `pass`，有待办为 `warn`。
- 已登录：冲突、错误或待同步/同步中为 `warn`；只有没有待办且没有错误时为 `pass`。
- 报告仍只保留状态、数量和建议，不加入密钥、地址、账号、队列内容或歌曲字段。
