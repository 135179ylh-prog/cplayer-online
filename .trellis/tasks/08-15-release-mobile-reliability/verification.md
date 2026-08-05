# Verification - 发布可追踪与手机可靠性冲刺

## 状态

本阶段已完成：独立提交、推送、Pages workflow 和最终线上 CDP 证据均已通过。

## 保护性基线

- 基线提交：`25e7d24`。
- 用户已有未提交文件：`07-25-playlist-trash-history` 目录下 5 项；本阶段不得暂存或修改。

## 验证记录

- `node --test tests/release-preflight.test.mjs`：17/17 通过；新增预缓存哈希契约测试通过。
- `python tests/verify_features.py`：通过；缓存数字阈值已替换为资源哈希和 workflow action 主版本契约。
- `npm run build:pages`：通过；产物 28 个文件、18,716,162 字节，生成 `build-meta.json`，本地 commit 为 `25e7d249bc56feec3e3acddceff7b665217ad1a7`，缓存名为 `cplayer5-v84-reliability-sprint`，预缓存哈希为 `sha256:bffd2fac8da5ea5832143d59437699824689342e7d9ada18c19f59df1a86de6f`（旧版 Windows CRLF 结果）。
- 移动 Pages 产物定向回归：播放生命周期 21/21、搜索恢复与触摸滚动 8/8、发布产物 3/3，共 32/32 通过。
- 桌面 Pages 产物定向回归：播放生命周期与搜索恢复 29/29 通过。
- 覆盖的播放边界包括顺序、单曲循环、列表循环、随机、页面隐藏、重复结束事件、下一首网络延迟、自动播放拒绝、用户手势恢复和旧预加载目标失效。
- 覆盖的搜索边界包括完整分页、重复结果、空分页、下一页失败保留结果并重试、旧请求污染隔离、触摸指针滚动自动加载和失败重试。
- 完整 `PW_PORT=48789 npm run verify`：10/10 质量层通过；47/47 单元测试、260/260 浏览器场景通过、12 项按项目设计跳过，依赖审计 0 vulnerabilities，Pages 产物 28 文件/18,716,162 字节，仓库检查通过。
- 全量浏览器回归包含桌面、Pixel 5 移动、355px 窄屏、440px 阔折叠、844px 横屏和 740px 紧凑横屏；发布元数据测试确认 `build-meta.json` 的 commit、缓存名和预缓存哈希与 `sw.js`/页面契约一致。
- 质量门禁之外的独立 Claude 只读分析和审阅均因上游 API 重试超时，分别留下 `research/claude-analysis.md` 与 `research/claude-review.md`，未修改产品代码，也没有给出“通过”结论；本地静态、单元和浏览器证据完整，因此未把外部审阅超时报成产品失败。
- Pages #102（run `30999443927`，commit `05b47a4`）失败，quality job 的唯一实际阻塞是 `actions/setup-python@v5` 的 Node.js 20 deprecation warning；deploy 未启动。已核实官方 `setup-python@v7.0.0`/`node24` 并修正 workflow，等待下一次独立 Pages run。
- Pages #103（run `31004488540`，commit `5c83b0b`）确认 action 版本已通过，但 quality 在预缓存契约第 33 项失败：Linux runner 计算 `sha256:e556302291b997f8858d131714af13958626eb0922e3052f5b2ca1d5cb0458ed`，仓库 Worker 仍为 Windows CRLF 结果 `sha256:bffd…`。已加入跨平台 LF 规范化和构建产物哈希测试，待独立修复提交后重跑。
- 跨平台修复后的定向回归：`node --test tests/release-preflight.test.mjs` 17/17、`python tests/verify_features.py` 通过、`npm run build:pages` 通过；Pages 产物 28 文件、18,709,153 字节，预缓存哈希统一为 `sha256:e556302291b997f8858d131714af13958626eb0922e3052f5b2ca1d5cb0458ed`。
- 跨平台修复后的完整 `npm run verify`：10/10 质量层通过；47/47 单元测试、260/260 浏览器场景通过、12 项按项目设计跳过，依赖审计 0 vulnerabilities；浏览器回归耗时约 8.1 分钟，仓库检查通过。
- 新增测试可靠性修复：移动动画回归允许 `MobileUIManager.updateInfo` 的一次性淡入帧与唯一的 FluidBackground 循环同窗存在，但仍严格检查持续循环回调唯一、`pending=1`、`maxPending=1`；隔离移动场景 20/20 通过。
- 最新 `npm run verify`：10/10 质量层通过；47/47 单元测试、260/260 浏览器场景通过、12 项按项目设计跳过，依赖审计 0 vulnerabilities；Pages 产物 28 文件、18,709,153 字节，仓库检查通过。
- 本地产物元数据（当前代码提交 `a282fb80f7207d1e16e4a390a05c71fc9339176d`）：缓存名 `cplayer5-v84-reliability-sprint`，预缓存哈希 `sha256:e556302291b997f8858d131714af13958626eb0922e3052f5b2ca1d5cb0458ed`，14 个核心资源均来自同一份 LF 规范化输入。
- 独立修复提交：`ccde42aa095668c30a60b47afe3427daa433a07b`（`fix: harden mobile animation regression timing`），已推送到 `main`；提交只包含本阶段 5 个文件，用户原有 5 个未提交文件仍保持未暂存。
- Pages #105：run `31011040865` 成功；quality job `92322980387` 和 deploy job `92325883256` 均为 `success`，run 对应提交 `ccde42aa095668c30a60b47afe3427daa433a07b`。
- 最终直接 CDP 线上验收：`build-meta.json`/`sw.js` 均返回 200，公开 commit 为 `ccde42aa095668c30a60b47afe3427daa433a07b`；页面 `cplayerReady=true`，Service Worker controller 已接管且 `active.state=activated`；CacheStorage 只有 `cplayer5-v84-reliability-sprint`，包含 14 个核心资源，预缓存哈希为 `sha256:e556302291b997f8858d131714af13958626eb0922e3052f5b2ca1d5cb0458ed`。

最终结果：代码可靠性回归、诊断脱敏、发布产物追踪、Pages 部署和直接 CDP 线上验收均有记录。
