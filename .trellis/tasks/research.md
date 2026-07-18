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
