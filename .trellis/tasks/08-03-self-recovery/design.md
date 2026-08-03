# 设计：本机恢复包

## 数据格式

顶层格式为 `cplayer-recovery-package`，版本为 `1`：

```json
{
  "format": "cplayer-recovery-package",
  "version": 1,
  "exportedAt": "2026-08-03T00:00:00.000Z",
  "playlists": [{ "sourceId": "user_pl_old", "name": "收藏", "songs": [], "deletedAt": 0 }],
  "history": [{ "sourcePlaylistId": "user_pl_old", "name": "收藏", "songs": [], "createdAt": 0, "reason": "edit", "snapshotId": "..." }]
}
```

导出只复制恢复所需字段，绝不把本地同步元数据或其他存储混入包内。

## 导入流程

1. 检查文件扩展名、大小、JSON、顶层格式、版本、数组数量和每首歌字段。
2. 规范化 active/trash/history，并在内存中建立旧 ID → 新 ID 映射。
3. 与现有 active/trash 名称比较，冲突名通过“（已恢复）”及序号去重。
4. 在一个 `playlists` + `playlist_versions` 的 `readwrite` 事务中写入全部记录。
5. 不访问、不写入 `cloud_outbox`；成功后刷新资料库和回收站视图。

## 边界与安全

- 任何校验错误发生在开启写事务之前。
- 导入历史快照时保留 `snapshotId`，但存储主键重新生成，避免与现有记录冲突。
- 恢复后的歌单保持本地所有权；第一次后续编辑由既有 `saveUserPlaylistRecord` 决定是否产生云同步任务。
