# Research - cplayer-online

## 后台播放
- 问题：createMediaElementSource 导致 WebAudio 在后台被挂起
- 解决：保持原生 audio 路径，不使用 WebAudio 路由

## 播放模式
- 4 种：sequence / repeat_one / repeat_all / shuffle
- 存储：localStorage cp_play_mode

## 歌单存储
- IndexedDB：CPlayer5DB.playlists
- key：user_pl_<timestamp>

## 歌单歌曲排序
- `songs` 数组顺序是自建歌单的唯一排序来源，无需新增字段或数据库迁移。
- 管理入口原先调用未定义的 `openPlaylistDetail`；本轮补齐详情弹窗、上移/下移、移除和播放入口。
- 每次修改前按歌单 id 重新读取最新记录，交换/删除后通过 `saveUserPlaylistRecord` 写回，避免用陈旧闭包覆盖顺序。
- 真实 Chrome 中发现浏览器扩展会对通用 `.modal-backdrop` 注入 `display:none !important`；改为应用专用 `.cplayer-modal-backdrop` 后设置弹窗恢复可见。

## 最近播放、备份与失败跳过
- 最近播放使用 `cp_recent_history`，由播放尝试 token 的首次真实 `play` 事件记录；暂停恢复不重复，重新加载同曲会更新到顶部。
- 自建歌单备份格式为 `cplayer-playlists-backup` v1；导入限制 5 MB，并在事务前验证全部歌单与歌曲字段。
- 同名导入使用“(导入)”后缀并生成新 id，不覆盖已有歌单；歌曲数组顺序原样保存。
- 播放模式已统一为 `sequence / repeat_one / repeat_all / shuffle`，读取旧 `single / random` 时迁移。
- 播放失败集合按队列索引去重；顺序模式不回绕，循环与随机模式可遍历其他候选，全部失败后稳定停止。
- 资料库在 355px 窄屏中把新建与备份分两行，保留 44px 触控目标，符合自用高频操作需求。

## 搜索与歌单操作
- 加入歌单弹窗位于统一侧栏/移动底部面板之外，原全局 click 监听器会把弹窗选择误判为外部点击并关闭底层面板。
- 移动当前播放歌曲行原 `+` 按钮没有绑定收藏处理器；现改为“歌单”按钮并复用统一收藏入口。
- 覆盖层命中由 `isOverlayInteractionTarget` 统一判断，搜索词与结果 DOM 在收藏流程中不重建。

## 2026-07-19 稳定性加固
- 发现空 `current_queue` 被视为无缓存，旧 `cp_playlistId` 会在刷新时重新加载；现按有效空队列恢复。
- 发现移动共享函数依赖 `window.mobileUI`，但实例只在模块变量中；现统一导出并修正搜索按钮的 `self` 误用。
- 发现封面缓存分支原先被 CDN 音频分支遮蔽；现先处理图片并限制缓存数量。
- 发现队列导入旧路径未更新 `window.playlist` 或 IndexedDB；现统一规范化、刷新和保存。
- 最终回归发现任意同域导航会覆盖 `index.html` 离线壳；现只允许播放器根路径和 `index.html` 更新该缓存，并以 `playlist-downloader.html` 作为防回归样本。

## 2026-07-24 账号与云同步长期 Goal

- Supabase Free 的账号与自建歌单同步已上线；播放器仍是本地优先，登录可选。
- 当前可用状态只有设置账号卡的一条文本，缺少真实 outbox 数量、冲突数量、
  最近成功时间、错误重试和桌面/手机入口摘要。
- 第 1 里程碑复用既有状态机、outbox 和冲突 Map 做单一投影，不改云数据库。
- 后续里程碑保持顺序发布，避免状态中心、数据模型和恢复能力同时变更而难以
  定位回归。
