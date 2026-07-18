# Implementation Notes - 自建歌单歌曲排序

## Ready Checklist

- [x] PRD、设计和实施计划已写入任务目录。
- [x] 已确认歌单记录存放在 IndexedDB `playlists`，排序由 `songs` 数组顺序表达。
- [x] 详情 UI 和操作逻辑已实现。
- [x] 静态语法与浏览器关键路径已验证。

## Constraints

- 当前 Codex 会话是唯一产品代码写入者。
- 不运行会覆盖用户现有改动的补丁脚本。
- 不新增后端或破坏性数据库迁移。
