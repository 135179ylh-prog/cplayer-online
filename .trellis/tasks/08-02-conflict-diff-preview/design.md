# Design - 冲突差异预览

## Data flow

```text
本地歌单 + 云端歌单
  -> cloud-sync.js normalizeSongObject
  -> diffPlaylistContent()
  -> app.js conflict preview renderer
  -> textContent-only DOM
```

差异计算放在 `js/cloud-sync.js`，作为跨层边界的唯一实现；UI 只渲染结果，不重新解释歌曲身份或云端字段。

## Diff contract

`diffPlaylistContent(localRecord, remoteRecord)` 返回：

- `nameChanged`、`localName`、`remoteName`
- `localSongCount`、`remoteSongCount`
- `localOnly`、`remoteOnly`：只在一侧出现的歌曲
- `metadataChanged`：同一歌曲的名称/歌手/专辑等信息不同
- `orderChanged`、`localOrder`、`remoteOrder`：共同歌曲的相对顺序不同
- `hasChanges`

歌曲身份使用规范化后的 `id`，数字和字符串分开编码，避免 `1` 与 `'1'` 被错误合并。显示条目只保留 id、名称、歌手、专辑等已规范化字段，最多展示 6 项，剩余数量用摘要说明。

## UI

设置里的冲突卡片增加：

- 一行差异摘要（名称、数量、顺序）
- 两个版本的差异分区：本机独有、云端独有、歌曲信息变化、顺序预览
- 现有“使用本机 / 使用云端”按钮保持原位置和行为

所有外部歌曲文本使用 `textContent` 写入；空状态、加载状态和错误处理沿用现有设置状态区域。差异列表使用 `max-height` 与 `overflow-y-auto`，手机不撑破设置弹窗。

## Safety

- 差异计算异常时只显示“差异预览暂时不可用”，不阻止原有冲突处理，也不写入任何数据。
- 恢复/覆盖操作仍由现有 `resolveCloudConflict` 执行；预览不会减少冲突计数或清理 outbox。
- 不引入新的网络请求。
