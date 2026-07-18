# Design - 自建歌单歌曲排序

## Scope

实现自建歌单详情管理闭环，复用现有 `listUserPlaylists`、`saveUserPlaylistRecord`、`loadUserPlaylistIntoQueue` 和 `normalizeSongObject`，不引入新的存储表或依赖。

## Data Flow

```text
IndexedDB.playlists
  -> listUserPlaylists()
  -> currentDetailPlaylistId / detail renderer
  -> move/remove operation (swap or splice)
  -> saveUserPlaylistRecord()
  -> IndexedDB.playlists
```

`songs` 数组的自然顺序是唯一排序来源。详情操作先按歌单 id 重新读取最新记录，再修改数组并保存，避免快速连续点击覆盖较新的顺序。

## UI

- 在页面中增加一个与现有弹窗风格一致的 `playlistDetailModal`。
- 顶部显示歌单名称和歌曲数量，并提供播放整单和关闭动作。
- 每行使用稳定的网格/弹性布局，显示封面、歌曲名、艺术家和播放/上移/下移/移除图标按钮。
- 上移/下移按钮根据当前索引禁用，并提供 `aria-label` 与 `title`。
- 详情刷新后保留当前歌单 id；歌单删除或不存在时显示可恢复的提示。

## Behavior and Errors

- 保存操作串行化；操作期间禁用当前详情按钮，失败时显示 toast 并重新读取服务端（IndexedDB）状态。
- 空歌单显示空状态，不渲染越界控制。
- 播放整单继续调用现有 `loadUserPlaylistIntoQueue`，排序后的数组自然成为队列顺序。
- 详情中的单曲播放只通过现有队列 API 加入/播放，不改变歌单记录。

## Compatibility

- 兼容已有 `user_pl_` 记录及缺少可选歌曲字段的旧数据。
- 不改变当前队列的 `currentIndex`、随机播放逻辑或队列自动保存。
- 所有任务文档和验证结果保存在 `.trellis/tasks/`。
- 设置与欢迎弹窗使用应用专用的 `cplayer-modal-backdrop` 类，避免浏览器扩展隐藏通用 `.modal-backdrop`。
