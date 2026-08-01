# Research - 手机后台自动续播可靠性

## 2026-07-30 根因证据

- 主音频只监听一个 `ended` 入口：`handleSongEnd()`。
- 列表循环与随机模式最终都通过 `window.playSongAtIndex(nextIndex)` 调用 `loadAndPlaySong()`，后者无条件重新执行 `musicService.getSong(id)`。
- `preloadNextSong()` 已经提前执行相同歌曲 API，但只写入独立 `preloadAudio.src` 和 `preloadedSongId`；代码库中没有任何结束切歌路径消费预取数据。
- 预取在 `audio.play()` 成功后仍等待固定 2 秒才开始；后台计时器节流会扩大未预取窗口。
- 因此播放模式计算本身不是共同故障点；共同故障点是结束切歌依赖后台时刻的新 API 请求。

## 既有合同

- 2026-07-22 的后台生命周期加固要求：用户选择的新请求等待时，旧媒体 `ended` 不得越过用户选择继续请求下一首。
- 保持原生音频元素，不重新引入 WebAudio 播放路由。
- 实体手机仍是系统后台行为的最终证据，浏览器测试只证明代码在结束时不再重复依赖歌曲 API。
