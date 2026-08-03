# 验证：一键同步健康检查

## 结果记录

| 检查项 | 结果 |
| --- | --- |
| `node --check js/app.js` | 通过 |
| `node --check sw.js` | 通过 |
| `python tests/verify_features.py` | 通过 |
| 健康检查定向 Playwright（桌面 + 手机） | 2/2 通过 |
| `npm run verify` | 通过：45 个单测、222 个浏览器测试通过，12 个按项目配置跳过 |
| GitHub Pages 线上验证 | 待推送后运行 |

## 浏览器验收矩阵

- 正常本机状态显示数据库、缓存、恢复入口和可选云同步状态。
- 检查前后 IndexedDB / localStorage / `cloud_outbox` 指纹一致。
- 导出的报告不含 API key、API 地址、队列、最近播放、播放进度或歌曲内容。
- 桌面 1280×800 与手机 390×844 均可见、可操作且不产生未处理异常。

## 证据

- 定向命令：`npx playwright test tests/e2e/cloud-health-check.spec.mjs --project=desktop-chromium --project=mobile-chromium`
- 完整命令：`npm run verify`
- 完整门禁还确认 Pages 构建产物上的 Service Worker、恢复包、冲突、离线和播放回归均通过。
