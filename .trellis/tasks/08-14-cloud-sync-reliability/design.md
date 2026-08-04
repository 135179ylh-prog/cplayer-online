# Design - 云同步与本地恢复可靠性冲刺（第二阶段）

## 当前数据流

```text
本机歌单变更
  -> IndexedDB playlists + cloud_outbox 原子写入
  -> scheduleCloudSync
  -> performCloudSync(ownerId)
  -> 读取本机、outbox、云端快照
  -> decidePlaylistSync
  -> push / pull / conflict / recover-copy
  -> acknowledgeCloudUpsert/Delete/Purge
  -> 更新健康检查和设置页状态
```

账号会话变化应使旧的 `ownerId` 失效。所有异步响应在写回 IndexedDB 或界面前，都必须再次确认当前账号仍是请求账号；本机清理标记则必须在刷新后可继续执行。

## 已观察到的风险点

- `cloudSyncInFlight` 已经合并同页同步请求，但需要验证账号切换、退出和迟到响应的所有写回路径。
- outbox 保存 `mutationId` 用于本机并发确认，但当前云端 RPC 主要依赖 `expectedVersion`；需要用“服务端已提交、客户端响应丢失”的测试确认用户是否会得到安全的冲突提示，而不是误报已同步。
- `CLOUD_DETACH_PENDING_KEY` 提供注销恢复入口，但当前浏览器回归只覆盖正常注销，缺少清理失败后刷新继续清理的证据。
- 退出登录会读取未限定账号的 outbox 数量用于本机提示，需要确认这不会把其他账号的具体信息或旧账号错误状态带入当前界面。

## 设计约束

- 先增加最小失败回归，再改一个根因；不以延长超时掩盖竞态。
- 优先复用现有 `ownerId`、`cloudPendingReadToken`、`mutationId`、`CLOUD_DETACH_PENDING_KEY` 和安全存储 helper，不新增平行状态系统。
- 浏览器测试使用请求边界 mock，不依赖真实 Supabase 可用性。
- 任何新增 UI 状态必须同时更新桌面和移动入口、可访问名称以及健康检查过期标记。
- 生产代码不得加入测试开关、固定账号、API 凭据或完整请求/媒体地址日志。

## 预期结果

```text
旧请求返回
  -> 比对 requestOwnerId === cloudUserId
  -> 不相等：丢弃写回并保持当前账号状态
  -> 相等：继续 acknowledge / conflict / health projection

注销清理中断
  -> 保留 confirmed detach marker
  -> 下次启动先 repairPendingCloudDetach()
  -> 清理 owner-scoped playlists/history/outbox
  -> 删除 marker
  -> 本机歌单内容保持可用
```

## 已落地的第一处修复

- 当普通 `upsert` 的云端版本高于本机版本，但 outbox 中的待同步内容与云端内容完全一致时，决策返回 `ack-upsert`，只确认已提交的同一份内容，不把响应丢失误报为冲突。
- `acknowledgeCloudUpsert()` 和同步循环在写回前后都确认 `cloudUserId === ownerId`。退出登录或账号变化后的迟到响应会被丢弃，旧账号 outbox 保留，不会把页面状态改回“已同步”。
- 内容不同仍然走原有冲突流程；没有新增 Supabase 表、RPC 参数或外部迁移。
