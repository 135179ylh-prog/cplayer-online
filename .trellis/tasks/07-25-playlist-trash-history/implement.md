# Implementation Plan - 删除回收站与历史版本

1. [x] 完成 PRD 收敛、技术设计和风险边界；读取 Trellis 开发规范并启动任务。
2. [x] 增加纯函数合同：歌单状态、历史快照规范化、30/90 天清理、restore/purge 同步决策和恢复副本命名。
3. [x] 把 IndexedDB 升级为 v6，追加 `playlist_versions`，实现原子快照、回收站状态、历史上限和 v5→v6 无损迁移。
4. [x] 扩展 owner-scoped outbox 为 upsert/delete/restore/purge，保证删除携带最后内容、历史批次幂等、mutationId 确认规则不退化。
5. [x] 增加 Supabase 迁移：`purged_at`、历史表/RLS、兼容旧 RPC、v2 写入/删除、purge 与机会式清理。
6. [x] 扩展 `CPlayerCloudService` 和同步循环：分页读取、历史按需拉取、trash/purge 传播、恢复冲突副本和状态中心计数。
7. [x] 在音乐资料库增加回收站标签页，在歌单详情增加历史入口和预览/恢复弹窗；完成空/加载/失败/确认反馈与无障碍状态。
8. [x] 补单元测试：边界校验、状态决策、快照去重/裁剪、过期规则、purge 不可复活和敏感字段排除。
9. [x] 补桌面/手机浏览器测试：未登录删除→刷新→恢复、历史预览/恢复、永久删除确认、30 天清理、离线 pending→联网、跨设备 trash/history/purge、v5→v6、quota、焦点/标签页/44px/无溢出。
10. [x] 更新 Service Worker 缓存版本、前端质量规范和 Trellis 验证矩阵；运行聚焦测试及完整 `npm run verify`。
11. [ ] 检查迁移与回退，独立提交；按“迁移先、Pages 后”执行生产发布并监控 GitHub Actions。
12. [ ] 在真实桌面 Chrome 与实体手机完成删除、离线、恢复、历史、永久删除和原有歌单不变验收；记录无凭据证据后归档任务，再进入冲突差异预览。

## Validation Commands

```powershell
npm test
$env:PW_PORT='<unused-port>'; npx playwright test tests/e2e/account-cloud-sync.spec.mjs tests/e2e/playlist-library.spec.mjs --project=desktop-chromium --project=mobile-chromium
$env:PW_PORT='<unused-port>'; npx playwright test tests/e2e/storage-resilience.spec.mjs tests/e2e/responsive-accessibility.spec.mjs
$env:PW_PORT='<unused-port>'; npm run verify
npm run check:rollback -- <known-v6-ref>
git diff --check
```

实际测试文件名以仓库现有套件为准，不为匹配计划另造重复套件。

## Risky Files And Rollback Points

- `js/app.js`：本机事务、outbox、同步循环和资料库 UI 共用；每一层完成后先跑聚焦测试。
- `js/cloud-sync.js`：所有云 payload 的唯一规范化边界；单测必须先于真实迁移。
- `supabase/migrations/`：只追加向后兼容迁移；生产执行前先做本地 SQL/静态检查，执行后不可用删表回退。
- `index.html` / `sw.js`：响应式弹窗和缓存更新必须一起验证最终 Pages 产物。
- IndexedDB v6：任何回退保持版本号不降低，禁止要求用户清除站点数据。

## Release Gate

- 产品代码、迁移、自动化测试和 Trellis 文档在同一里程碑独立提交。
- 完整 verify、生产迁移、推送、Actions quality/deploy、线上桌面/手机真实验收依次通过，才标记里程碑完成。
- 任一真实流程出现数据不一致，停止后续写操作，保留本机记录、历史和 outbox，先记录状态再修复。
