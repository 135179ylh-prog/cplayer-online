# 验证：同步失败可恢复化——最近错误持久化

## 结果记录

| 检查项 | 结果 |
| --- | --- |
| 最近错误保存与读取单元/浏览器回归 | 通过：账号云同步定向回归 34/34 |
| 同步失败 → 刷新 → 错误仍可见（桌面） | 通过：1/1 |
| 同步失败 → 刷新 → 错误仍可见（手机） | 通过：1/1 |
| 其他账号错误不泄露（桌面/手机） | 通过：2/2 |
| 重试成功清除错误与待同步项目（桌面/手机） | 通过：2/2 |
| `node --check js/app.js` / `node --check sw.js` | 通过 |
| `python tests/verify_features.py` | 通过：stability checks passed，构建标记 v33，核心资源 14 个 |
| `npm run verify` | 通过：45 个单元测试、228 个浏览器场景通过，12 个按配置跳过；依赖审计 0 vulnerabilities；Pages 构建 27 文件/18,693,894 字节 |
| GitHub Pages 线上验收 | 通过：Actions #85（commit `78d7fb0`）completed successfully；线上标题 `CPlayer 5`，`cplayerReady=true`，Service Worker 已控制页面，CacheStorage 为 `cplayer5-v77-sync-error-persistence` |

## 验收矩阵

- 同步失败原因只来自脱敏用户提示。
- 刷新后当前账号仍可见最近错误和重试入口。
- 账号切换不显示其他账号错误。
- 重试成功后错误隐藏、待同步数量为 0、`cloud_outbox` 为空。
- 不影响未登录本地播放和本机数据。

## 命令证据

- `npx playwright test tests/e2e/account-cloud-sync.spec.mjs --project=desktop-chromium --project=mobile-chromium --workers=1`：34/34 通过，包含刷新恢复和账号隔离场景。
- `npm run check:repo`：通过，新增文档无额外末尾空行。
- `npm run verify`：10/10 质量层通过；45/45 单元测试、228/240 浏览器场景通过，12 项按视口配置跳过；依赖审计 0 漏洞。
- 说明：一次全量回归中的既有手机动画时序场景出现单次抖动，单独重复 5/5 通过；随后完整门禁重新运行并通过，未修改该无关场景。
- GitHub Actions：`Deploy GitHub Pages #85` 对提交 `78d7fb0` 完成成功，quality 与 deploy job 均通过。
- web-access/CDP：线上页面标题 `CPlayer 5`，`document.documentElement.dataset.cplayerReady=true`，Service Worker controller 存在且脚本为线上 `/sw.js`，CacheStorage 检测到 `cplayer5-v77-sync-error-persistence`；线上 `js/app.js` 包含 `cp_cloud_last_error`、`readCloudLastError()` 和 `rememberCloudSyncError()`。
