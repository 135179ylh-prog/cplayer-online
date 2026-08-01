# Verification - 手机后台自动续播可靠性

## 已完成证据

- 红灯复现：列表循环与随机模式各 1 项失败；下一首虽已预取，旧代码在 `ended` 后仍停在原歌曲，证明结束路径没有消费预取结果。
- 修复后聚焦回归：新增列表循环与随机交接用例 2/2 通过。
- 后台生命周期套件：桌面与手机 28/28 通过，包含用户主动切歌所有权、队列变化后拒绝过期预取、自动播放拒绝恢复和媒体会话边界。
- 播放失败回归：`npx playwright test tests/e2e/playback-error.spec.mjs --reporter=line`，桌面与手机 4/4 通过。
- 分层检查：`npm run check:module`、`npm run check:sw`、`npm run check:features` 与 `git diff --check` 均通过。
- 完整发布门禁：`npm run verify` 退出码 0，10/10 层通过；43 个单元测试通过；Pages 构建产物上的浏览器回归 208 个通过、12 个按项目/视口规则跳过、0 个失败；依赖审计 0 个漏洞；仓库检查通过。

## 待完成

- 无。

## 线上部署

- 独立提交：`0beeb10 fix: stabilize mobile background auto advance`。
- 已推送 `main`；GitHub Actions `Deploy GitHub Pages` 第 60 次运行（run `30476166827`）中，`quality` 与 `deploy` 均为 `success`，部署的 head SHA 为 `0beeb104d187913a50c5f300148ef2a70e2ed499`。
- 正式站直接读取验证：`sw.js` 为 `cplayer5-v68-background-handoff`；`js/app.js` 包含 `preloadedNextMedia`、`preloadNextSong(attempt)`，且不存在旧的 2 秒预取结构。
- 真实 Chrome 后台标签刷新到新 Worker 后：页面 `cplayerReady=true`、构建标记 `v32`、Service Worker 已控制页面，持久化队列正常恢复并可发起歌曲播放请求。
- 自动化后台标签不能等同于手机系统后台冻结，因此额外保留实体手机验收作为最终证据。
- 2026-08-01 实体手机验收（用户确认）：列表循环和随机模式在后台自然播放结束后均能自动进入下一首，无停住问题。
