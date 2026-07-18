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
