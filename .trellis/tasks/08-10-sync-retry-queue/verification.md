# 验证：待同步项目可恢复化

## 结果记录

| 检查项 | 结果 |
| --- | --- |
| 单项/全部重试回归 | 通过：账号云同步定向回归 36/36（桌面/手机各 18） |
| 桌面 1280×800 | 通过：具体待办、离线禁用、单项重试、全部重试 |
| 手机 390×844 | 通过：具体待办、离线禁用、单项重试、全部重试 |
| `node --check js/app.js` / `node --check sw.js` | 通过 |
| `python tests/verify_features.py` | 通过：stability checks passed，构建标记 v33，核心资源 14 个 |
| `npm run verify` | 通过：45 个单元测试、230/242 浏览器场景通过，12 项按配置跳过；依赖审计 0 漏洞；Pages 构建 27 文件/18,704,421 字节 |
| GitHub Pages 线上验收 | 待运行 |

## 验收矩阵

- 当前账号的具体待同步项目可见，其他账号名称不泄露。
- 单项重试不清除其他 outbox 项。
- 全部重试成功后 outbox 为空；冲突/失败仍可恢复。
- 最近错误、健康检查和脱敏报告使用同一条安全提示文本。
- 离线时本机播放和待办列表仍可用。

## 命令证据

- `npx playwright test tests/e2e/account-cloud-sync.spec.mjs --project=desktop-chromium --project=mobile-chromium --workers=1`：36/36 通过，包含新增长期维护回归。
- `npm run verify`：10/10 质量层通过；45/45 单元测试、230/242 浏览器场景通过，12 项按视口配置跳过；依赖审计 0 漏洞。
- Service Worker 缓存版本已更新为 `cplayer5-v78-sync-retry-queue`。
