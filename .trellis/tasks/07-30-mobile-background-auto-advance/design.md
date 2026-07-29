# Design - 手机后台自动续播可靠性

## 根因

现有 `preloadNextSong()` 会提前调用歌曲 API，但只保存 `preloadedSongId` 并把 URL 交给独立的 `preloadAudio`。`handleSongEnd()` 完全不读取这份结果，而是调用 `playSongAtIndex()`，继而再次调用歌曲 API。手机进入后台后，结束事件后的 JavaScript、计时器和普通网络请求更容易被系统延迟；因此循环和随机模式共用的结束路径都可能停住。

预取还放在成功播放后的 2 秒 `setTimeout` 中。用户开始播放后很快切到后台时，计时器本身也可能被节流，导致下一首从未准备。

## 数据流

```text
当前歌曲开始播放
  -> 立即计算当前模式下的下一索引
  -> musicService.getSong(nextId)
  -> preloadedNextMedia { index, songId, data, mediaUrl, ownerToken }
  -> preloadAudio 预热同一媒体 URL

当前媒体 ended
  -> 重新按当前队列/模式计算 nextIndex
  -> 校验并消费匹配的 preloadedNextMedia
  -> loadAndPlaySong(nextId, { preloadedMedia })
  -> 无需再次调用歌曲 API；失配时走原联网路径
```

## 安全合同

- 预取由当前已提交媒体的 attempt token 所有；旧播放请求返回的预取结果不得覆盖新歌曲。
- 消费时同时核对索引、字符串化歌曲 ID、URL 和当前计算结果，不能只凭 ID。
- 预取失败保持静默并清空对应缓存，不影响当前歌曲。
- 新歌提交、队列清空和媒体重置会让旧预取失效；即使没有主动清理，消费校验也必须拒绝失配结果。
- `loadAndPlaySong` 仍是提交媒体身份、更新 UI、歌词、Media Session、错误恢复和自动播放处理的唯一入口；预取只替换歌曲 API 读取阶段。

## 验证策略

- 浏览器红灯用例先让 B 在 A 播放期间成功预取，再阻塞 B 的第二次歌曲 API 请求并触发 A 的 `ended`；旧代码会停住，新代码必须直接切到 B。
- 分别覆盖 `repeat_all` 与 `shuffle`，并保留已有“用户选择 B 等待时 A ended 不得请求 C”回归。
- 静态合同拒绝延迟 2 秒后才调用 `preloadNextSong` 的旧结构。
