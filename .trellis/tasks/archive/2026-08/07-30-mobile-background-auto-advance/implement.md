# Implementation Plan - 手机后台自动续播可靠性

1. [x] 追踪 `ended -> playSongAtIndex -> loadAndPlaySong -> MusicService.getSong`，确认现有预取结果未被消费且被 2 秒计时器延迟。
2. [x] 增加列表循环和随机播放的红灯浏览器测试：预取成功后阻塞重复歌曲 API 请求，结束事件仍应切歌。
3. [x] 把单一 `preloadedSongId` 提升为带所有权和完整媒体数据的预取记录，并提供严格校验/消费边界。
4. [x] 让 `loadAndPlaySong` 可消费有效预取数据，结束切歌优先传入该数据；失配时保持现有联网回退。
5. [x] 播放成功后立即启动预取，移除 2 秒延迟，同时保持旧请求竞态保护。
6. [x] 更新 Service Worker 缓存版本、前端媒体生命周期规范和静态合同。
7. [x] 运行聚焦桌面/手机测试及完整 `npm run verify`，记录结果。
8. [ ] 独立提交、推送、等待 Pages 成功并完成正式站与实体手机验收。
