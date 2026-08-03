# 设计：一键同步健康检查

## 数据流

```text
设置按钮 → collectCloudHealthSnapshot() → 只读 IndexedDB / 浏览器能力检查 → renderCloudHealthSnapshot()
                                                      ↘ sanitizeCloudHealthReport() → JSON 下载
```

健康检查只读取 `db.version`、`objectStoreNames`、`cloud_outbox` 数量和现有内存状态；不读取歌单歌曲、队列、最近播放或播放进度用于报告。

## UI

- `#cloudHealthCheckBtn`：开始检查。
- `#cloudHealthCheckStatus`：当前检查状态和建议。
- `#cloudHealthCheckList`：逐项结果。
- `#cloudHealthCheckExportBtn`：下载脱敏诊断报告。

结果状态：

- `pass`：可用或未登录但本机优先模式正常。
- `warn`：可继续使用，但需要联网、登录或刷新。
- `fail`：本机能力受阻，需要按建议处理。

## 报告契约

报告仅包含生成时间、检查项 id/status/detail、数据库版本与 store 名称、数量、布尔值和建议。不得包含 `apikey`、API URL、owner/user id、email、歌单/歌曲字段、队列、最近播放或播放进度。

## 缓存

修改 `index.html` 与 `js/app.js` 后将 Service Worker cache name 更新为 `cplayer5-v74-sync-health-state`。
