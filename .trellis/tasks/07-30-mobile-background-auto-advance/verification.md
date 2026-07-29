# Verification - 手机后台自动续播可靠性

## 已完成证据

- 红灯复现：列表循环与随机模式各 1 项失败；下一首虽已预取，旧代码在 `ended` 后仍停在原歌曲，证明结束路径没有消费预取结果。
- 修复后聚焦回归：新增列表循环与随机交接用例 2/2 通过。
- 后台生命周期套件：桌面与手机 28/28 通过，包含用户主动切歌所有权、队列变化后拒绝过期预取、自动播放拒绝恢复和媒体会话边界。
- 播放失败回归：`npx playwright test tests/e2e/playback-error.spec.mjs --reporter=line`，桌面与手机 4/4 通过。
- 分层检查：`npm run check:module`、`npm run check:sw`、`npm run check:features` 与 `git diff --check` 均通过。
- 完整发布门禁：`npm run verify` 退出码 0，10/10 层通过；43 个单元测试通过；Pages 构建产物上的浏览器回归 208 个通过、12 个按项目/视口规则跳过、0 个失败；依赖审计 0 个漏洞；仓库检查通过。

## 待完成

- 独立提交并推送 `main`，等待 GitHub Pages 部署成功。
- 正式站基础播放与实体手机后台自然结束验收。
