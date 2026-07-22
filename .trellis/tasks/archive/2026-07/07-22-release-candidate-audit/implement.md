# Implement - 发布候选审计与交付

## 执行顺序

1. [x] 汇总已归档任务和当前测试，建立 Goal 五项与八链路证据矩阵。
2. [x] 修正 manifest 音质过度承诺，提升 Service Worker 缓存并更新静态契约。
3. [x] 编写发布说明、发布步骤、回退方案和实体设备验证清单。
4. [x] 运行快速契约检查，确认发布元数据、缓存和 Pages 产物同步。
5. [x] 执行完整 `npm run verify` 与四视口回归，记录实际计数。
6. [x] 完成 Trellis 验证记录与 Goal 剩余项审计。
7. [x] 创建本地提交、归档、journal；不 push、不部署。

## 验证命令

- `npm run check:features`
- `npm run check:sw`
- `npm run verify`（`PW_PORT=4174`）
- `git diff --check`
- `git status --short --branch`

## 高风险位置与回退点

- manifest 属于 Service Worker 核心资源，文案变化也必须提升缓存名。
- 当前门禁只有 Chromium；实体 Android 结果不能从 Playwright 推断。
- 发布文档不得包含真实 API 密钥或要求清空用户数据。
- 不执行远端操作；发布步骤只能记录，等待用户明确确认。
