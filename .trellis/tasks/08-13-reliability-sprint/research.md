# Research - CPlayer 可靠性冲刺

## 已完成的只读调查

- 当前分支为 `main`。
- 工作区已有用户未提交改动，位于 `.trellis/tasks/07-25-playlist-trash-history/`；没有产品源码未提交改动。
- `js/app.js` 已有四种播放模式、`ended` 处理、媒体 attempt token、下一首预加载、API 重试、共享搜索 pager 和触摸 `pointermove`。
- `tests/e2e/runtime-background-resilience.spec.mjs` 已覆盖部分隐藏页面、列表循环、随机、延迟请求和自动播放拒绝，但没有完整四模式矩阵。
- `tests/e2e/search-recovery.spec.mjs` 已覆盖首屏、手动/自动分页、后续页失败重试、旧查询迟到响应和按钮区域触摸 Pointer Events，但没有重复页/空页/接口总数缺口的完整回归。
- `tests/core-utils.test.mjs` 已覆盖基本搜索去重、正常总数和空数据，但未验证重复页或空页继续推进。
- `js/app.js` 当前播放失败路径主要写控制台；没有统一的可查看播放诊断缓冲。

## 实施后证据（2026-08-04）

- 播放回归已证明 `endedHandled` 能阻止隐藏页面重复 `ended` 跳过目标歌曲，同时顺序、单曲循环、列表循环、随机均保持正确。
- 搜索回归已证明重复页和空页在 total 尚未满足时会推进 offset；失败重试、旧查询隔离和触摸滚动均在桌面/手机通过。
- 诊断回归已证明报告字段只包含固定的非敏感状态；假 API key/API 地址、歌曲 URL、歌曲标识和播放进度均不进入内存报告，也没有诊断存储键。
- `npm run check:module`、`npm run check:features` 和 `npm run test:unit` 已通过；完整 `npm run verify` 已通过（10/10，252 个浏览器用例通过、12 个按配置跳过）。

## 初始假设（待用红灯验证）

1. 结束事件令牌去重可以阻止重复 `ended` 导致的跳歌，同时保留四种模式的正常行为。
2. 以请求偏移/limit 推进 pager，并把去重限制在渲染层，可以处理重复页和接口报告总数大于已显示数量的空页，而不会无限请求。
3. 内存环形诊断加设置页只读视图可以满足本机故障定位，同时天然避免 API key、API 地址、媒体 URL 和播放进度落盘或上传。

## 待补证据

- Claude 独立分析与审查：已尝试，详见 `research/claude-analysis.md`；因 12 轮上限退出，没有可采纳 verdict，按失败处理。
- 红灯/绿灯定向浏览器输出：已完成，详见 `verification.md`。
- 独立提交、推送、GitHub Actions Pages 运行和线上验收结果。
- 每个独立提交、GitHub Actions Pages 运行和线上验收结果。
