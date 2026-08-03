# 研究记录：本机恢复包

## 现有实现

- 普通歌单备份已在 `js/app.js` 中实现校验、下载和原子导入。
- 用户歌单、回收站和历史快照分别位于 `playlists` 与 `playlist_versions`，两者均使用 IndexedDB。
- 云同步待办位于 `cloud_outbox`；恢复包方案明确不导出也不写入该 store。
- `normalizePlaylistVersion`、`makeRecoveredPlaylistName`、`createUserPlaylistId` 可复用，避免第二套字段规则。

## 决策

采用单文件 JSON 恢复包，而不是覆盖式数据库快照：它可读、可审查，导入是 additive，不会覆盖当前歌单；新 ID 也能避免跨设备或旧数据碰撞。

## 风险

- 历史快照主键与快照业务 ID不同，导入时必须保留 `snapshotId` 但重新生成 IndexedDB `id`。
- 旧版本浏览器可能没有历史 store；应让导出得到空历史，导入仍可恢复歌单。
- 线上验收必须使用临时数据并在结束后清理，不能污染真实账户。
