# Research - 冲突差异预览

## Existing behavior

- `js/cloud-sync.js` 已提供 `normalizeCloudSong`、`toCloudPlaylistInput`、`decidePlaylistSync` 和冲突状态投影。
- `js/app.js` 的 `cloudConflicts` 保存本机、云端和 outbox，设置卡片已有“使用本机 / 使用云端”。
- 现有冲突流程只显示歌单名称和位置，不展示内容差异。
- Supabase 与 IndexedDB 契约已经足够支撑只读预览，不需要迁移或 DB 版本变更。

## Decision

采用客户端纯函数比较，按歌曲 id 对齐；只在共同歌曲中比较元数据与相对顺序。列表展示限制为前 6 项，避免大歌单造成设置弹窗卡顿或手机页面过长。

## Risks

- 同一歌单含重复歌曲 id 时，差异只能按首次出现的 id 对齐；本阶段不引入逐条 occurrence 身份。
- 远端回收站/永久删除冲突可能没有歌曲内容，仍要显示名称、数量和空状态，不把空列表误判为数据丢失。
