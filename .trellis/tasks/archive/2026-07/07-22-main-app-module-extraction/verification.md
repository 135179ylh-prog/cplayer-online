# Verification - 主应用模块拆分与性能基线

## 验证结论

2026-07-22 完成。主应用已从 HTML 内联模块迁移为唯一的 `js/app.js` 外部入口，业务文本规范化对比完全一致；Service Worker、Tailwind、静态契约和浏览器升级路径均已同步。没有改 UI、数据格式或 API 行为，没有推送或部署。

## 迁移等价证据

- 迁移前 Git 版本的主模块与新 `js/app.js` 在统一换行、去除入口首尾空白并调整唯一相对 import 后：`Equal=True`。
- 对比字符数：迁移前 281486，新文件 281486。
- 新文件 SHA-256（UTF-8 规范化文本）：`17085a5d814183bd943a29be27a3b4a08232dc7df39eecd02a6ba93276b2d001`。
- 唯一必要的代码差异是 `from './js/core-utils.js'` → `from './core-utils.js'`，因为模块解析基准从 HTML 变为 `js/app.js`。

## 文件与资源基线

| 资源 | 迁移前 | 迁移后 |
| --- | ---: | ---: |
| `index.html` | 388269 bytes | 94219 bytes |
| 主应用脚本 | 内联，约 281 KB | `js/app.js`，294057 bytes |
| HTML + 主应用脚本 | 388269 bytes | 388276 bytes |
| HTML 体积变化 | - | 减少 294050 bytes（75.73%） |
| 生成 `css/tailwind.css` | 28643 bytes | 28643 bytes，字节级未变化 |

首次加载总字节数没有被宣称降低；本阶段确认的是 HTML 体积、独立缓存粒度和可重复资源边界。

## 自动验证

| 命令 | 结果 |
| --- | --- |
| `npm run build:css` | 通过；Tailwind 新增扫描 `js/app.js`，生成 CSS 与迁移前一致 |
| `npm run check:module` | 通过；直接检查 `js/app.js`，`RECENT_HISTORY_KEY` 1 处，脚本 281482 字符（Python 换行归一化） |
| `npm run check:features` | 通过；HTML/APP 来源契约、Tailwind、缓存和发布资源均通过 |
| `npm run check:sw` | 通过 |
| `npm test`（由完整门禁执行） | 10/10 单元测试通过 |
| `npm audit`（由完整门禁执行） | 0 个漏洞 |
| 定向 `app-shell + service-worker-update` | 10 个用例中 9 通过、1 个移动离线壳重复场景按设计跳过 |
| `npm run verify`，`PW_PORT=4174` | 8/8 层通过；82 个浏览器用例中 80 通过、2 个原有预期跳过 |
| `git diff --check` | 通过；只有 LF/CRLF 转换提醒，无空白错误 |

## 浏览器与缓存证据

- desktop Chromium `1280x800`：`/js/app.js` 响应 1 次，HTTP 200，`text/javascript; charset=utf-8`，Performance Resource 的 initiator 为 `script` 且 `transferSize > 0`。
- mobile Chromium `390x844`：同样响应 1 次并到达 `waitForAppReady`。
- narrow mobile `355x800` 与 wide foldable `440x707`：完整响应式/无障碍回归保持通过。
- Service Worker 缓存从 v55 升到 `cplayer5-v56-main-app-module`，核心资源由 10 个变为 11 个，升级后的当前缓存明确包含 `/js/app.js`。
- 升级后切换离线并点击“刷新”，应用壳、队列、最近播放、播放进度会话仍按原测试恢复。

## 已知提醒与回退

- 构建继续提示 `caniuse-lite` 数据可更新，但不影响结果；未混入无关依赖升级。
- 回退不需要数据迁移：恢复主模块内联入口、旧检查器、Tailwind 配置和 Service Worker 缓存名即可。
- 本阶段没有实体设备测速；性能基线只记录静态资源大小和浏览器资源边界，不等同于真实 Android/iOS 网络耗时。
