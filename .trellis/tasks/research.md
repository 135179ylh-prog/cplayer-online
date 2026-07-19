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
