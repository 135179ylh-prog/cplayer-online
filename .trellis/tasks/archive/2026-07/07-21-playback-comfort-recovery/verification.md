# Verification - 播放舒适度与状态恢复

## 计划

- `npm run build:css`
- `npm test`
- `python scripts/check_module_syntax.py`
- `node --check sw.js`
- `python tests/verify_features.py`
- `git diff --check`
- 浏览器验证恢复进度、睡眠设置/取消/到点暂停、桌面与移动布局、不同失败提示。

## 结果

### 自动化检查（2026-07-21）

- `npm run build:css`：通过；Tailwind 静态 CSS 构建成功。仅提示 `caniuse-lite` 数据可更新，不影响构建。
- `npm test`：通过；9 个单元测试全部成功，覆盖恢复记录、实际音源末尾边界、睡眠剩余时间、失败分类、音质分类和网络重试。
- `python scripts/check_module_syntax.py`：通过；页面模块脚本语法正确。
- `node --check sw.js`：通过；Service Worker 语法正确。
- `python tests/verify_features.py`：通过；构建标记为 `v32`，核心资源与新增接线检查成功。
- `git diff --check`：通过；没有空白错误。Git 仅提示部分文件下次写入时会从 LF 转为 CRLF。
- 本地自审：恢复应用阶段现在与保存阶段共用 `getSafePlaybackResumeTime`；如果新音源时长变短并使旧进度靠近歌曲结尾，会清理记录而不是重复提示。

### 真实浏览器验证（Chrome / Playwright）

- 桌面 `1280 × 800`：设置窗口完整显示，睡眠定时控件可操作。
- 手机 `390 × 844`：设置窗口完整显示，没有文字或控件溢出。
- 边界修复后的新浏览器启动验证：页面首屏和移动设置窗口加载成功，控制台无错误或警告。
- 睡眠定时：15 分钟可设置，刷新后仍显示剩余 15 分钟，取消后本地记录被删除。
- 到点处理：用短截止时间验证到期路径，截止后 `cp_sleep_timer_end_at` 被删除，控制台无错误或警告。
- 进度恢复：写入一首本地测试歌曲和 0:42 恢复记录后刷新，页面提示“已找回上次进度 0:42，点击播放继续”，没有自动播放。
- 队列清理：确认清空队列后，`cp_playback_session` 被删除。
- 截图：`research/desktop-sleep-timer-1280.png`、`research/mobile-sleep-timer-390.png`。

### 尚未覆盖

- 外部音乐接口返回的真实音频能否稳定播放取决于第三方服务，本轮未把第三方在线成功率当作本地功能通过条件。
- Claude 只读复核因不可用并按用户指示跳过。
