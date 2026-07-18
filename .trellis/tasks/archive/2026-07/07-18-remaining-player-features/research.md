# Research - 剩余播放与备份功能

## Existing Evidence

- 当前 `index.html` 没有最近播放、备份导出/导入或 `audio.error` 处理。
- `loadAndPlaySong` 的 API 错误只显示失败，`audio.play()` 的所有拒绝都被当作自动播放拦截吞掉。
- 旧 `patch_full_features.py` 用全局计数重试并调用 `handleSongEnd`，无法防止整张坏歌单无限循环，也不能区分 `NotAllowedError`。
- 现有播放模式常量使用 `sequence/repeat_one/repeat_all/shuffle`，但导航函数仍读取 `single/random`，桌面模式按钮还同时绑定新旧两个切换器。
- 自建歌单已通过 `listUserPlaylists` / `saveUserPlaylistRecord` 使用 IndexedDB，可复用同一 object store 完成备份恢复。
- 设置页 `fileImportSection` 中存在破损的 `<div` / `id="settingsDropZone"` 标签，真实浏览器会显示原始属性文本。

## Decisions

- 最近播放使用 localStorage，避免为有限历史升级 IndexedDB 版本。
- 导入使用单事务而非循环调用 `saveUserPlaylistRecord`，保证失败时不留下半成品。
- 播放失败链按队列索引去重，并通过请求 token 拒绝迟到响应。
- 资料库使用标签而不是在同一面板纵向堆叠两个长列表。

## Peer Review Status

用户明确说明 Claude 暂时不可用；本任务不启动 Claude，会以 Codex 自查、静态门禁和真实浏览器证据替代，待用户通知恢复后再使用。

## Implementation Findings

- 真实浏览器验证确认旧设置标签损坏会由 HTML 解析器吞并；修复后 `settingsDropZone` 是独立 `DIV`，页面不再显示原始属性文本。
- 最近播放测试通过受控 `fetch` 和 `HTMLMediaElement.play` 触发真实 `play` 事件：52 首裁剪为 50 首，重复歌曲移到顶部，暂停后继续播放不重复记录。
- 备份往返使用真实 IndexedDB 与文件输入：同名歌单生成“(导入)”后缀，歌曲顺序保持；第二首非法歌曲会在事务前拒绝，数据库记录数不变。
- 5 MB + 1 字节文件通过真实文件输入被拒绝，提示“备份文件超过 5 MB 限制”，导入按钮恢复可用。
- 受控失败队列依次覆盖 API 异常、非 HTTP URL、`play()` 拒绝和 `audio.error`；每个索引只尝试一次，最后成功歌曲才进入最近播放。
- 355×715 窄屏弹窗无横向溢出或按钮重叠；备份操作拆成独立一行后，比四个控件挤在同一行更适合日常触控。

## Evidence Files

- `research/library-desktop-v28.png`
- `research/library-mobile-v28.png`
- `research/recent-mobile-v28.png`
- `research/backup-valid.json`
- `research/backup-invalid-song.json`
- `research/backup-wrong-version.json`
