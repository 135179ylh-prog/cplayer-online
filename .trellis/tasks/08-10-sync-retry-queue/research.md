# 研究：待同步项目可恢复化

## 现有实现

- `cloud_outbox` 以 `ownerId:playlistId` 为键，每个歌单最多一条待办；记录包含 `operation`、`playlist` 快照、`expectedVersion` 和 `updatedAt`。
- `refreshCloudPendingCount()` 已经按账号读取 outbox；同步入口是 `syncCloudPlaylists()`，实际决策集中在 `performCloudSync()`。
- 设置页已有待同步数量、最近错误、冲突差异预览和健康检查入口，适合在同一张卡片内扩展。

## 主要风险

- 单项重试如果删除或改写其他 outbox，会造成用户看不见的待办；实现必须只过滤决策循环，不改变未选项目。
- 未登录时读取全部 outbox 可能泄露其他账号名称，因此列表展示必须只绑定当前 `cloudUserId`。
- 健康检查不能把 `Error` 对象直接序列化；只能复用已经脱敏的最近错误文本。

## 远端回归时序分析（2026-08-04）

- GitHub Actions #87 的唯一失败发生在新增长期维护回归：第二次创建歌单后，测试立即断言页面列表包含“全部重试歌单”，远端实际只完成了第一条 IndexedDB 写入。
- 本地复现路径和产品代码均正常；失败边界在测试读取持久化状态之前，没有等待第二次写入完成，而不是同步决策、outbox 或 UI 渲染逻辑丢数据。
- 修复采用条件等待：第一次创建后轮询 `readUserPlaylists(page)` 出现“单项重试歌单”，第二次创建后轮询出现“全部重试歌单”，再断言 UI。没有加入固定睡眠，避免掩盖真正的持久化问题。
