# Verification - 云同步与本地恢复可靠性冲刺（第二阶段）

## 初始基线

| 范围 | 桌面 | 手机 | 结果 |
| --- | --- | --- | --- |
| 云同步账号、离线、冲突、回收站、历史、注销 | ✅ | ✅ | `account-cloud-sync.spec.mjs` 36/36 |
| 云同步健康检查 | ✅ | — | `cloud-health-check.spec.mjs` 2/2 |
| 恢复包导出/预览/导入 | ✅ | ✅ | `recovery-package.spec.mjs` 10/10 |
| IndexedDB/localStorage/配额/版本升级 | ✅ | ✅ | `storage-resilience.spec.mjs` 20/20 |
| 单元测试 | — | — | 45/45 |

## 本轮新增证据（2026-08-04）

- 失败回归先稳定复现：模拟云端写入成功但响应断开时，修复前重试状态为 `conflict`，而不是安全确认。
- `npm run test:unit`：46/46 通过，新增“相同内容的已提交 upsert 可安全确认”合同。
- `account-cloud-sync.spec.mjs` 定向竞态回归：桌面/手机 4/4 通过，覆盖响应丢失重试和退出登录后迟到响应。
- 注销清理标记刷新恢复回归：桌面/手机 2/2 通过；本机歌单内容保留，owner 字段和 marker 清除。
- 完整 `account-cloud-sync.spec.mjs`：42/42 通过（桌面 21、手机 21）。
- 完整 `npm run verify`：10/10 通过；单元 46/46，Pages 产物浏览器回归 258/258 通过、12 个按配置跳过，依赖审计 0 vulnerabilities，仓库检查通过。Pages 产物回归耗时约 9.5 分钟，因此命令执行窗口必须覆盖完整矩阵。

## 发布传播复核与 v83 修复（2026-08-04）

- CDP 读取 Actions #99（run `30897910969`）：`Status: Success`，`quality` 9m56s、`deploy` 11s，部署地址为 `https://135179ylh-prog.github.io/cplayer-online/`。
- 初次线上验收发现：页面可加载且 Worker 为 `activated`，但 CacheStorage 只有 `cplayer5-v82-reliability-sprint`；线上 `app.js`/`cloud-sync.js` 缺少 `817dea1` 的 `ack-upsert` 标记。这证明 workflow 成功不等于旧 Worker 已升级。
- 先将静态回归阈值提升到 v83，`python tests/verify_features.py` 在 v82 上按预期失败；再把 `sw.js` 的 `CACHE_NAME` 提升为 `cplayer5-v83-reliability-sprint` 后，该回归通过，`npm run check:sw` 也通过。
- v83 修复后的完整 `npm run verify`：10/10 层通过；单元 46/46，Pages 产物浏览器回归 258/258 通过、12 个按配置跳过，依赖审计 0 vulnerabilities，仓库检查通过。
- Actions #100（run `30900153091`，commit `5583c2d`）：`Status: Success`，`quality` 10m、`deploy` 9s，部署地址为 `https://135179ylh-prog.github.io/cplayer-online/`。
- v83 线上复验：页面 `ready=complete`、`document.documentElement.dataset.cplayerReady=true`；Service Worker `activated` 且 controller 为线上 `/sw.js`；CacheStorage 仅有 `cplayer5-v83-reliability-sprint`。
- 线上最终脚本核对：`app.js` 同时包含 owner 隔离和 `decision.action === 'ack-upsert'`，`cloud-sync.js` 包含 `return { action: 'ack-upsert' }`；旧 v82 缓存已不存在。

## 待补证据

- [x] 退出期间的迟到同步响应不会污染当前账号或清除旧账号 outbox。
- [x] 模拟云端已提交但客户端响应丢失时，重试确认相同内容并清空已完成 outbox。
- [x] 注销清理失败后刷新能完成 `CLOUD_DETACH_PENDING_KEY` 修复。
- [x] 既有账号隔离回归确认前一账号错误不显示给当前账号。
- [x] 上述新增场景桌面/手机均通过，且真实 IndexedDB 状态与 UI 一致。
- [x] `npm run verify` 完整通过（10/10）。
- [x] v83 修复独立提交、Pages 成功和线上验收完成。

## 记录规则

每次验证记录命令、视口、通过/失败数量和关键持久化证据。超时必须记录实际运行时长与拆分后的结果，不能用“应该通过”替代证据。所有日志、报告和截图不得包含 API 凭据、会话令牌或其他敏感本机数据。
