# Design - CPlayer 可靠性冲刺

## 当前证据与根因假设

- `handleSongEnd()` 以当前 `committedMedia` 决定下一步，但没有记录“这个媒体令牌已经处理过结束事件”；重复事件或后台边界事件可能重复计算下一首。
- 现有测试覆盖了隐藏页面的列表循环和随机，以及自动播放拒绝，但没有覆盖四种模式的完整结束矩阵，也没有在所有模式下覆盖下一首网络请求延迟。
- `createSearchResultPager()` 用 `addedSongs.length > 0` 决定是否还有下一页；当上游页重复或为空而 `total` 仍大于当前偏移时，可能提前结束。
- 现有播放失败日志只写控制台，没有统一的、可查看的本机脱敏诊断状态。

## 已落地的修复边界

- `committedMedia.endedHandled` 随媒体身份创建，在真正开始播放时解除；`handleSongEnd()` 还要求 `audio.ended === true`，因此旧媒体重复事件不会重复切歌。
- 搜索 pager 依据已推进的 offset 和接口 total 判断是否继续；重复页和空页不会把游标卡死，也不会因去重后新增数为零而提前结束。
- 播放失败统一进入有界内存诊断缓冲；失败类别、来源和错误名称使用白名单，记录不携带歌曲 ID、歌曲文本、媒体 URL、API 配置或进度。

## 播放结束数据流

```text
audio ended
  -> 校验 committedMedia 与当前 audio 源
  -> 按 media token 去重
  -> 记录本机脱敏诊断事件
  -> 计算四种模式的 nextIndex
  -> 提交新的 playback attempt
  -> API 延迟期间忽略旧媒体的重复 ended
  -> play() 成功继续；NotAllowedError 保持暂停并等待用户手势
```

去重状态必须随 `commitMediaIdentity()` 和 `resetPlaybackIdentity()` 一起失效，不能跨歌曲复用。手动上一首/下一首可以显式建立新 attempt，但不能让旧媒体事件影响新 attempt。

## 搜索分页数据流

```text
API page(offset, limit)
  -> normalizeSearchPage 保留 total、请求偏移和可继续的 nextOffset
  -> mergeUniqueSearchSongs 按稳定 ID 去重
  -> 若 total 仍有缺口且偏移已前进，继续分页
  -> 空页/重复页受有界推进保护，不无限请求
  -> 失败只设置当前 pager error，保留已有结果并允许按钮重试
  -> query request id 失效时丢弃迟到响应
```

分页推进应以接口的 offset/limit 为主，而不是以“本页新增了多少首”为主；去重只影响渲染数量，不应阻止在总数尚未满足时继续尝试后续偏移。若接口没有可靠 total，则使用本页长度与 limit 的保守规则，并在空页停止。

## 本机播放诊断

- 采用内存环形缓冲，保留最近有限条事件；不写 localStorage、IndexedDB、云同步或网络。
- 事件字段只包含：时间、播放模式、队列索引、页面可见性、在线状态、错误分类/名称、媒体错误码、播放来源和重试次数。
- 明确排除：API key、API base URL、查询参数、完整媒体 URL、歌曲名/歌手/封面、播放进度。
- 设置页增加“本机播放诊断”只读区域和清除按钮；可通过 `window.getCPlayerPlaybackDiagnostics()` 给浏览器回归读取，测试不依赖控制台文本。
- UI 只显示脱敏摘要，复制/导出不是自动行为；本轮优先提供查看和清除，避免把诊断发送到外部。

## 已验证的诊断契约

- `playback-error.spec.mjs` 在桌面和手机项目均验证：诊断字段集合固定、假 API key/API 地址不进入报告、没有诊断存储键、设置页可查看并清除。

## 兼容与缓存

- 生产 `js/app.js` 或 `index.html` 改动后更新 Service Worker `CACHE_NAME`。
- 测试 fixture、Trellis 文档和本机输出不触发缓存版本升级。
- 不触碰已有 IndexedDB schema、歌单记录和云同步协议。
