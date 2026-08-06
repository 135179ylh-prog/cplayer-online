# 实施计划：发布验收自动化与门禁分层

## 保护性基线

- 基线提交：`825044d`。
- 用户已有未提交改动：`.trellis/tasks/07-25-playlist-trash-history/` 下 3 个文档和
  2 张截图，共 5 项。本阶段不得暂存、覆盖或删除。

## 步骤

1. [x] 读取 AGENTS.md、`.trellis/workflow.md`、当前任务文档和 `git status`。
2. [x] 并行侦察：e2e 五类回归覆盖矩阵、静态契约写法、历史直接 CDP 证据字段。
3. [x] `pages-contract.mjs` 抽出 `computePrecacheRevisionFrom(loadAsset)`。
4. [x] 重写 `scripts/run-quality-gate.mjs` 为十层可选、可恢复、带状态和日志。
5. [x] 新增 `scripts/check-pages-release.mjs`：HTTP 契约 + 线上字节重算哈希 + 直接 CDP。
6. [x] `package.json` 增加 `verify:list`/`verify:status`/`verify:resume`/`check:release`。
7. [x] `.gitignore` 忽略 `output/quality-gate/` 和 `output/pages-release-check.json`。
8. [x] 补强回归：搜索旧首页污染、重试游标、隐藏切歌可见 UI、健康报告真实下载脱敏。
9. [x] `tests/release-preflight.test.mjs` 覆盖分层门禁纯函数和线上核对纯函数。
10. [x] `tests/verify_features.py` 锁住新层、新命令、新回归和 README 说明。
11. [x] README 记录分层门禁和线上核对流程。
12. [x] `.trellis/spec/frontend/quality-guidelines.md` 固化可重复验收契约。
13. [ ] 完整 `npm run verify` 十层通过。
14. [ ] 独立提交并推送到 `main`（只含本阶段文件）。
15. [ ] 等待 Pages quality/deploy 均 success。
16. [ ] `npm run check:release -- --commit=<新 commit>` 线上验收并记录证据。
17. [ ] 更新 `verification.md`，确认临时 Chrome/端口/临时目录已清理。

## 安全约束

- 不暂存或修改用户已有 5 项未提交文件。
- 线上核对不读也不记录 API 密钥、API 地址、token、账号身份、歌单或播放进度。
- 临时 Chrome 使用独立临时配置目录，结束时关闭进程并删除目录；不操作用户标签页。
- 不强制推送，不改写远端历史，不清空用户网站数据。
