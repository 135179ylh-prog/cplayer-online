# 验证：本机恢复包

## 当前状态

- [x] 单元测试：45 通过、0 失败
- [x] 桌面浏览器测试：恢复包 3/3 通过
- [x] 手机视口测试：恢复包 3/3 通过
- [x] `npm run verify`：216 个浏览器用例通过、12 个既有视口条件跳过；0 失败
- [x] GitHub Pages 部署与线上复验

## 本地证据

- `node --check js/app.js`：通过。
- `python tests/verify_features.py`：通过，build badge 为 `v33`，Service Worker 为 `cplayer5-v71-self-recovery`。
- `npx playwright test tests/e2e/recovery-package.spec.mjs`：桌面与手机共 6/6 通过。
- `npm run verify`：10/10 质量门禁通过；Pages 产物浏览器回归 216 通过、12 跳过。
- GitHub Actions Pages 工作流 #68：`success`，部署提交为 `7817246`。
- 线上桌面浏览器（`https://135179ylh-prog.github.io/cplayer-online/`）：`v33`、`cplayerReady=true`、存储状态 `ready`；资料库显示“本机恢复包”及导出/恢复按钮，原有本地歌单与回收站数据保持不变。
- 手机视口由同一 Pages 产物的 `mobile-chromium` 回归覆盖，恢复包 3/3 通过；未对真实账户执行导入，避免污染用户数据。

覆盖内容：active/trash/history 导出、敏感字段排除、新 ID 导入、历史 ID 映射、回收站保留、损坏文件原子失败，以及导入不产生 `cloud_outbox`/pending。

## 验收记录

实现完成后记录命令输出、测试数量、工作流编号、线上版本和任何手工限制。未覆盖的真实设备行为必须明确标注为手工验证，不扩大自动化结论。
