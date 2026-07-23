# Design - 同步状态中心

## Single Source Of Truth

状态中心不建立第二套同步状态机。现有 `setCloudState` 继续拥有状态转换，
新增的内存快照只保存可观察事实：`pendingCount`、`conflictCount`、
`lastSuccessfulAt` 和 `lastError`。纯函数 `projectCloudSyncStatus` 把这些事实
统一投影到设置入口、账号卡和根元素 dataset。

```text
IndexedDB cloud_outbox ──> pendingCount ─┐
cloudConflicts Map ──────> conflictCount ├─> projectCloudSyncStatus
setCloudState ───────────> state/message ┤      ├─ desktop/mobile settings indicator
local last-success record ───────────────┘      ├─ account status center
                                                └─ html data-cplayer-cloud-*
```

UI 不直接读取数据库或解析 Supabase 响应。同步流程负责取得事实，投影函数
负责同一份文案、颜色、计数和无障碍摘要。

## Status Rules

- 状态枚举保持 `disabled / signed-out / pending / syncing / synced /
  conflict / error`。
- 视觉优先级为 `error > conflict > syncing > pending > synced > signed-out /
  disabled`，但基础登录状态不被改写。
- `pendingCount` 对已登录用户只统计当前 owner；退出或未配置时统计本机全部
  outbox，仅用于提示“登录对应账号后继续”，绝不跨 owner 发送。
- 每次完整取得本地、outbox、云端三份集合后，在临时 Map 中重算冲突；只有
  整轮没有异常时才替换当前 owner 的旧冲突，避免残留假冲突或半轮丢失。
- 只有 `remaining.length === 0 && conflictCount === 0` 才进入 `synced`、记录
  最近成功时间并允许“同步完成”提示。
- `lastSuccessfulAt` 以 `{ ownerId, at }` 写入安全 localStorage 封装。它只是
  本机观测元数据，不上传、不进入歌单备份；账号不匹配时不显示。
- 最近错误保留到成功、退出或禁用；重试过程中不静默丢失失败原因。

## UI

- 桌面 `#settingsBtn` 与手机 `#mobileSettingsBtn` 各增加一个非交互状态点；
  `title` 和 `aria-label` 使用同一个完整摘要。
- `#cloudAccountCard` 顶部增加状态徽标、待同步/冲突计数、最近成功和错误区。
  复用唯一 `#cloudAccountStatus[role=status]`，不增加竞争的 live region。
- 已登录的现有同步按钮按状态显示“立即同步”或“重试同步”。冲突仍使用现有
  两个显式选择按钮，并显示 `当前 / 总数`。
- 所有按钮保持至少 44px；计数与状态点不伪装成按钮。设置对话框继续由现有
  overlay/focus/inert 管理器拥有。

## Failure And Local-First Boundary

- 读取 outbox 失败不假装为 0；同步错误进入 `error`，本机记录和 outbox
  原样保留。
- 离线修改先完成本地歌单 + outbox 原子事务，再更新状态中心；播放不等待。
- Supabase payload 仍只包含歌单 id、名称、歌曲和乐观版本。API 密钥、API
  地址、队列、最近播放、播放进度、睡眠定时和设备设置不进入本次数据流。
- 不改 DB_VERSION、Supabase 表、RLS 或 RPC，因此无需迁移和数据库回退。

## Release And Rollback

修改 `index.html`、`js/app.js`、`js/cloud-sync.js` 和预缓存 CSS 后升级
Service Worker cache。发布前运行完整质量门禁。若线上状态中心异常，做保留
IndexedDB v5 与现有云同步数据边界的前向修复；不能清空本机数据或回退到
打开 v4 的版本。
