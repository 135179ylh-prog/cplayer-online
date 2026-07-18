# Verification - 自建歌单歌曲排序

## Status

功能实现和关键路径验证完成。

## Static Checks

- `python check_recent.py`：退出码 0，提取主内联脚本成功。
- `node --check _check.js`：退出码 0。
- `git diff --check`：退出码 0；输出仅包含 Git 的 CRLF 转换提示。
- 结构断言：详情弹窗、排序函数、管理入口、专用模态框类与 Service Worker v41 缓存名均为预期数量。

## Browser Checks

- Playwright（390 × 844）：从“歌单”打开详情；第一首上移、最后一首下移禁用；下移后顺序立即刷新；确认移除后歌曲数从 3 变 2。
- Chrome CDP（用户真实浏览器）：设置弹窗 `display:flex`，管理详情显示 3 首歌。
- Chrome CDP：点击“下移 One”后 UI 与 `CPlayer5DB.playlists` 都返回 `Two, One, Three`。
- Chrome CDP：重新导航并打开详情后仍返回 `Two, One, Three`，证明顺序持久化。
- Chrome CDP：空歌单返回 `0 首`、空状态、0 行且禁用“播放整单”；单曲歌单的上移/下移同时禁用。
- 测试记录 `user_pl_codex_sort_test` 和本次创建的 Chrome 标签均已清理，用户原标签未关闭。
- 桌面渲染截图：`research/chrome-detail.png`，未发现按钮或文本重叠。

## Known Baseline

- 本地仓库没有 `playlist.js`，页面存在既有 404；应用会回退到空播放列表。
- Tailwind 浏览器运行时输出既有 CDN 生产告警；本轮未新增控制台异常。
