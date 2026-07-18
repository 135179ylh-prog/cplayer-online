# Design - 剩余播放与备份功能

## Scope

继续沿用单页 PWA 架构，只修改 `index.html`、`sw.js`、生成的 `_check.js` 及 Trellis 文档。复用现有歌曲规范化、IndexedDB `playlists` object store、队列插入和播放入口。

## Music Library UI

- 将现有 `myPlaylistsModal` 扩展为“音乐资料库”，使用“我的歌单 / 最近播放”标签。
- 桌面顶部增加资料库图标按钮；移动端继续使用现有“歌单”按钮。
- 歌单标签提供新建、导出、导入和歌单列表；最近标签提供历史列表和清空。
- 固定操作按钮尺寸与可访问名称，列表区独立滚动，保持窄屏无重叠。

## Recent Plays

```text
audio play event
  -> active playback attempt metadata
  -> normalize + deduplicate by song id
  -> localStorage cp_recent_history (newest first, max 50)
  -> recent renderer
```

每次 `loadAndPlaySong` 创建新的播放 token。只有对应 token 首次触发 `play` 事件时才写历史，暂停后继续播放不会重复写；同一歌曲以后重新加载播放会更新最近时间。

## Playlist Backup

导出格式：

```json
{
  "format": "cplayer-playlists-backup",
  "version": 1,
  "exportedAt": "ISO-8601",
  "playlists": [{ "name": "...", "songs": [] }]
}
```

导入边界统一由 `parsePlaylistBackup` 负责。先完成全量结构校验和歌曲规范化，再开启一个 IndexedDB readwrite 事务写入全部新记录；任何校验或事务错误都不改变现有歌单。

## Playback Failure Controller

每次加载创建 `{ token, index, songId, failedIndexes, failureHandled, recentRecorded }`。异步 API、`audio.play()` 和 `audio.error` 共用一个失败入口：

```text
failure -> mark current index -> select next untried index by mode
        -> load next with same failedIndexes
        -> stop when no untried candidate remains
```

- token 防止旧请求覆盖用户后来选择的歌曲。
- `NotAllowedError` 单独处理为等待用户手势，不加入失败集合。
- `sequence` 到末尾停止；`repeat_all` 循环；`repeat_one` 正常结束重播当前曲，但故障时跳过当前坏歌；`shuffle` 按打乱顺序寻找未失败项。
- 旧值 `random/single` 在读取时迁移为 `shuffle/repeat_one`，所有入口只写规范值。

## Errors and Compatibility

- 导入、存储和播放错误使用现有 toast；详细错误保留在控制台。
- 全部歌曲失败后暂停并显示稳定失败态，不递归重试。
- 修复设置页现有损坏的 `settingsDropZone` 标签，使桌面歌单管理不再显示原始 HTML 文本。
- Service Worker 缓存名与页面构建标记同步提升。

## Implemented Details

- 页面构建标记提升为 `v28`，Service Worker 缓存提升为 `cplayer5-v42-library-backup-failure-skip`。
- 资料库使用桌面居中、移动端底部贴边的同一弹窗；新建与备份操作在窄屏分两行，最近播放行保持单行播放按钮。
- 新建输入支持回车，标签支持左右方向键，弹窗支持背景点击、Esc 和焦点返回。
- 备份导入限制 5 MB、500 个歌单、单歌单 10000 首；歌曲字段和名称长度在事务前统一验证。
- 播放尝试通过单调 token 拒绝迟到响应；成功触发 `play` 后清空上一条故障链的失败集合。
