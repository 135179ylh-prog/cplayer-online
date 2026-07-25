# Design - 删除回收站与历史版本

## Architecture

沿用现有静态 Pages + IndexedDB + Supabase RPC 架构，不增加服务器进程：

```text
音乐资料库 UI
  -> 本机歌单状态与历史快照（IndexedDB v6）
  -> owner-scoped cloud_outbox（离线可写、按歌单折叠）
  -> js/cloud-sync.js 统一校验与 RPC
  -> Supabase 当前歌单 + 历史快照（RLS）
```

本机写入永远先成功才反馈。登录后才发送云请求；未登录或云配置不可用时，回收站和历史功能仍完整运行。

## Playlist State Model

现有 `playlists` store 继续保存用户歌单，新增两个可选时间字段：

| 状态 | `deletedAt` | `purgedAt` | 名称/歌曲 | 默认界面 |
| --- | ---: | ---: | --- | --- |
| active | 0 | 0 | 完整保留 | 我的歌单 |
| trash | 时间戳 | 0 | 完整保留 | 回收站 |
| purged marker | 时间戳 | 时间戳 | 清空为通用占位名和空数组 | 不展示 |

- 普通删除只把 active 改为 trash，不再从 IndexedDB 直接移除。
- 恢复把 trash 改回 active，并写 `restore` outbox。
- 永久删除会删除该歌单的本机历史。纯本地歌单可彻底移除；曾绑定云账号的歌单保留无内容 marker 和 `purge` outbox，直到云端确认后仍保留最小 marker 防止旧设备复活原 ID。
- 所有默认歌单读取必须显式排除 trash/purged；回收站读取必须只包含 trash。

## Local History

IndexedDB 升级到 v6，追加 `playlist_versions` store，keyPath 为 `id`，索引：

- `playlistId`：按歌单读取。
- `createdAt`：按时间清理。
- `cloudOwnerId`：账号隔离和注销清理。

快照字段为本机全局唯一 `id`、云协议内的 `snapshotId`、`playlistId`、`name`、`songs`、`createdAt`、`reason`、`cloudOwnerId`。服务端 `snapshotId` 只在 owner + playlist 范围唯一（例如不同歌单都可能有 `server-1`），拉入 IndexedDB 时必须生成 owner + playlist + snapshot 的复合本机 `id`，上传时仍发送原 `snapshotId`。修改现有歌单前先保存旧内容；新建歌单不产生空快照。恢复历史版本时先快照当前内容，再把选中快照作为新的当前内容，因此恢复前状态仍可追溯。

每次本机事务后按 playlistId 清理超过 90 天或排序在第 20 个之后的快照。关键写入失败沿用 `runCriticalStorageWrite`：只允许清理可丢弃缓存，绝不清理歌单、回收站、purge marker 或历史。

历史读取、裁剪、覆盖和永久删除都必须先按 `cloudOwnerId` 划定范围。当前账号可接管同歌单的旧版无 owner 快照，但不得改写或删除其他账号的快照。

## Outbox Contract

现有 outbox 保持“一位 owner + 一个 playlistId 只有一行”，操作扩展为：

- `upsert`：普通新建或编辑。
- `delete`：进入回收站，携带最后的名称/歌曲，避免离线编辑后紧接删除造成内容丢失。
- `restore`：恢复回收站或历史版本；正常按原 ID upsert。
- `purge`：永久删除内容和历史，只携带 ID 与期望云版本。

`upsert/delete/restore` 同时携带该歌单尚未确认的本机历史快照，最多 20 个。新操作替换旧 outbox 时合并并按快照 ID 去重；服务端以 `(user_id, playlist_id, snapshot_id)` 幂等插入。只有 mutationId 仍与已发送任务一致时才能清除 outbox，保持现有并发保护。

## Cloud Schema And RPC

新增迁移 `202607250001_playlist_trash_history.sql`：

1. `cplayer_playlists` 增加 `purged_at timestamptz`。
2. 新建 `cplayer_playlist_versions`，保存 owner、playlistId、snapshotId、名称、歌曲、原因和创建时间；启用并强制 RLS，只授予本人读取。
3. 更新旧 upsert/delete RPC：变更前保存服务端当前快照，并拒绝修改 purge marker，保证旧客户端也不能复活永久删除 ID。
4. 新增带客户端历史批次的 v2 写入/删除 RPC，以及 `purge_cplayer_playlist`。
5. 新增 `cleanup_cplayer_playlist_data`：把超过 30 天的 tombstone 转为 purge marker，并清理超过 90 天或每歌单第 20 个之后的历史。
6. active + trash 合计最多 500 个；purged marker 不计入该上限。客户端分别分页读取可见歌单和 marker，避免 marker 挤占 500 行结果。

永久删除只保留 user_id、playlist_id、版本和 purge 时间等同步所需元数据；名称、歌曲和历史全部清除。账号删除仍通过外键级联删除所有记录。

## Sync Decisions

- 远端 trash + 本机干净：拉入本机回收站。
- 本机 delete + 远端期望版本一致：推送 tombstone；成功后保留本机 trash 并更新云版本，不再删除本机内容。
- 本机 restore + 远端版本一致：恢复原 ID。
- 本机 restore + 远端已有较新 active：若内容相同则确认；否则把待恢复内容改为新 ID 和“（已恢复）”名称，再拉取远端内容到原 ID。
- 远端 purged + 本机干净：应用无内容 marker。
- 远端 purged + 本机有未同步内容：把本机内容保存为新 ID 的恢复副本，再应用 marker；原 ID 永不复活。
- 本机 purge + 远端较新且未 purge：进入现有显式冲突处理，不能静默删除较新的云内容。

同步状态中心继续以真实 outbox 行数为 pending 数；restore/purge 不另建第二套状态。自动清理生成的 purge 任务也计入 pending，失败保留重试入口。

## UI And Accessibility

- 音乐资料库增加第三个“回收站”标签页，展示名称、歌曲数、删除时间和剩余天数；每行提供恢复和永久删除图标按钮。
- 永久删除使用明确的二次确认，文案说明名称、歌曲和历史均不可恢复。
- 歌单详情工具栏增加“历史版本”入口；历史弹窗展示时间、歌曲数和恢复按钮，选择一项后可预览歌曲列表再恢复。
- 空、加载、失败和成功状态均有稳定区域；未知图标提供 `title` 和 `aria-label`。
- 新标签页使用现有 `setAccessibleTabState` 和方向键导航；历史弹窗使用现有 LIFO overlay 管理。手机所有按钮至少 44x44，列表使用稳定网格，文本可换行且不产生页面横向溢出。

## Cleanup And Time Rules

- 30 天按 `deletedAt + 30 * 24h` 计算，界面显示向上取整的剩余天数。
- 启动后数据库就绪时运行本机清理；每次云同步开始时调用账号级云清理。
- 清理失败不阻止播放或读取歌单，但进入存储/同步错误状态并保留数据或待办。
- 客户端时间仅决定本机项目何时排队；云端到期以 Supabase UTC 时间为准。

## Compatibility And Rollback

- v5→v6 只添加 object store 和字段，不改写现有 active 歌单；旧记录缺少时间字段时按 active 处理。
- Service Worker 缓存版本随生产 HTML/JS 变化递增。
- 发布顺序为：先执行可向后兼容的 Supabase 迁移，再发布 Pages。迁移保留旧 RPC 签名。
- 用户打开 v6 后不能部署只会打开 v5 的旧版本；回退必须做前向 revert 并保持 DB v6。
- 若新版 Pages 失败，可回退界面/同步调用但保留新表、新列和兼容 RPC；不得清浏览器数据或删除云表。
