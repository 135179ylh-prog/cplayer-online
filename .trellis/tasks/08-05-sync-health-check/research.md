# 研究记录：一键同步健康检查

## 现有实现

- `js/app.js` 已有 `storageState`、`initDatabase()`、`readCloudOutbox()`、云同步状态投影和恢复包/导入预览入口。
- `index.html` 的账号同步卡片是桌面和手机共用的设置内容，适合放置只读检查入口。
- Service Worker 已使用 `cplayer5-v72-recovery-import-preview`，发布静态资源后必须递增版本。

## 取舍

- 不做真实 Supabase 探测：第三方网络瞬时故障会让本机健康检查产生不确定结果，也可能触发无意义请求。
- 不把敏感数据“先读出来再过滤”：检查报告直接从计数、状态和能力值构造，避免误导出。
- 待同步数量使用现有 `readCloudOutbox()`，以保持账号过滤规则一致。
