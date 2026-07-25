# Bug Analysis: 历史版本身份与账号范围混淆

## 1. Root Cause Category

- **Category**: B/D/E - Cross-Layer Contract + Test Coverage Gap + Implicit Assumption
- **Specific Cause**: Supabase 的 `snapshot_id` 只在 `user_id + playlist_id`
  范围唯一，但 IndexedDB 的 `id` 是全局 key。实现把两者当成同一个身份，且
  某些清理只按 `playlistId` 工作，没有先按 `cloudOwnerId` 划定范围。

## 2. Why Fixes Failed

1. 最初单歌单测试全部通过，因为没有两个歌单同时产生 `server-1`。
2. 原 owner 隔离测试只检查当前歌单记录，没有在同 ID 下放入另一账号的孤立历史。
3. 只有从 SQL 复合主键一路追到 IndexedDB keyPath 和 purge 清理，才暴露身份范围被压扁的问题。

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Architecture | 本机 `id` 与云端 `snapshotId` 分离；远端快照使用 owner + playlist + snapshot 复合存储 ID | DONE |
| P0 | Runtime | 所有历史读取、裁剪、覆盖、purge 先按 owner 范围过滤 | DONE |
| P0 | Test Coverage | 桌面/手机覆盖跨歌单重复 `server-1` 和同 ID 外账号历史永久删除 | DONE |
| P1 | Documentation | 更新前端可执行合同和跨层思考清单 | DONE |

## 4. Systematic Expansion

- **Similar Issues**: tombstone、purge marker、outbox 也同时具有 owner 和实体 ID；继续保持 owner-scoped key 与查询。
- **Design Improvement**: 每个跨层身份明确写出“全局唯一范围”，不要用字段名相同推断语义相同。
- **Process Improvement**: 数据库复合主键映射到浏览器存储时，强制增加“不同 scope 重用同一子 ID”的对抗测试。

## 5. Knowledge Capture

- [x] `.trellis/spec/frontend/quality-guidelines.md` 已补本机 ID / wire snapshot / owner 合同。
- [x] 已在仓库跟踪的 `.trellis/spec/frontend/index.md` 补 scoped identity 思考检查项；全局通用 guides 目录按项目规则保持忽略。
- [x] 单元、桌面和手机回归已进入完整 `npm run verify`。
- [x] 当前项目没有 `src/templates/markdown/spec/`，无可同步的模板副本。
