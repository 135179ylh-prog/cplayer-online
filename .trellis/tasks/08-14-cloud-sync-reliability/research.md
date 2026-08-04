# Research - 云同步与本地恢复可靠性冲刺（第二阶段）

## 现状证据（2026-08-04）

- `npm run test:unit`：45/45 通过。
- `cloud-health-check.spec.mjs` 桌面：2/2 通过。
- `account-cloud-sync.spec.mjs` 桌面/手机：36/36 通过。
- `recovery-package.spec.mjs` 桌面/手机：10/10 通过。
- `storage-resilience.spec.mjs` 桌面/手机：20/20 通过。
- 将四个套件一次性放入同一条命令时超过 180 秒并被外层命令终止，出现 EPIPE；拆分后各套件通过。该现象目前归类为运行时长/输出管道问题，不作为产品失败证据。

## 代码核对

- `js/app.js` 使用 `cloudSyncInFlight` 合并同页同步，并在同步读取和逐歌单处理阶段检查 `cloudUserId`。
- `js/app.js` 使用 `CLOUD_DETACH_PENDING_KEY` 在账号删除后恢复本机 owner 标记、历史和 outbox 清理。
- `js/cloud-sync.js` 的 RPC 调用携带 `expectedVersion`，本机 outbox 另外保存 `mutationId`；当前 RPC 签名未携带 mutationId。
- `tests/e2e/account-cloud-sync.spec.mjs` 已覆盖正常注销、账号隔离、离线待办和重试，但未覆盖注销清理失败后刷新修复，也未覆盖同步响应迟到时账号已切换的写回边界。

## 当前假设

1. 同页请求合并和 owner 检查可能已经足够，但需要用可控的延迟响应回归证明所有写回点都受保护。
2. 响应丢失时，乐观版本冲突可能是预期安全结果；需要验证 UI 是否保留 outbox 并给出可操作的冲突选择。
3. 注销恢复逻辑可能正确但缺少测试；若测试暴露清理顺序或状态显示问题，优先修复客户端事务和状态投影。

## 已确认根因与处理

- “云端已提交但客户端响应丢失”原先在 `remote.version > localVersion` 且本机有 dirty outbox 时无条件进入 `conflict`。现在只有 outbox 普通更新与云端内容完全一致时才返回 `ack-upsert`；内容差异仍保留冲突。
- “退出登录后迟到响应”原先可能继续执行 `acknowledgeCloudUpsert` 并在同步收尾阶段投影 `synced`。现在所有确认写回和同步收尾都检查 owner；旧账号 outbox 不会被清除。
- 注销确认标记刷新修复回归通过，证明 owner 标记清理不会删除本机歌单内容。

## 外部边界

本轮不调用真实 Supabase 管理接口，不推送数据库迁移，不读取或记录真实账号、API 地址、密钥或会话内容。若需要服务端幂等键，先形成单独设计和迁移说明。

## 2026-08-04 Pages 缓存传播复核

- Actions #99（run `30897910969`）显示 `Success`，`quality` 与 `deploy` 均成功，但线上页面的 CacheStorage 仍为 `cplayer5-v82-reliability-sprint`。
- 线上通过同源 `fetch` 检查发现 `app.js` 与 `cloud-sync.js` 均没有 `817dea1` 新增的 `ack-upsert` 代码；线上 Worker 状态为 `activated`，说明问题发生在旧缓存传播，而不是 workflow 未执行。
- 历史提交显示每次生产预缓存资源变化都会递增 `CACHE_NAME`。因此本轮采用单一根因修复：递增到 `cplayer5-v83-reliability-sprint`，不改 API、数据库或用户数据。
