# Verification - 发布可追踪与手机可靠性冲刺

## 状态

尚未完成，待实现后逐项记录命令、通过数量、提交、Pages workflow 和线上 CDP 证据。

## 保护性基线

- 基线提交：`25e7d24`。
- 用户已有未提交文件：`07-25-playlist-trash-history` 目录下 5 项；本阶段不得暂存或修改。

## 验证记录

- `node --test tests/release-preflight.test.mjs`：17/17 通过；新增预缓存哈希契约测试通过。
- `python tests/verify_features.py`：通过；缓存数字阈值已替换为资源哈希和 workflow action 主版本契约。
- `npm run build:pages`：通过；产物 28 个文件、18,716,162 字节，生成 `build-meta.json`，本地 commit 为 `25e7d249bc56feec3e3acddceff7b665217ad1a7`，缓存名为 `cplayer5-v84-reliability-sprint`，预缓存哈希为 `sha256:bffd2fac8da5ea5832143d59437699824689342e7d9ada18c19f59df1a86de6f`。
- 移动 Pages 产物定向回归：播放生命周期 21/21、搜索恢复与触摸滚动 8/8、发布产物 3/3，共 32/32 通过。
- 桌面 Pages 产物定向回归：播放生命周期与搜索恢复 29/29 通过。
- 覆盖的播放边界包括顺序、单曲循环、列表循环、随机、页面隐藏、重复结束事件、下一首网络延迟、自动播放拒绝、用户手势恢复和旧预加载目标失效。
- 覆盖的搜索边界包括完整分页、重复结果、空分页、下一页失败保留结果并重试、旧请求污染隔离、触摸指针滚动自动加载和失败重试。
- 完整 `PW_PORT=48789 npm run verify`：10/10 质量层通过；47/47 单元测试、260/260 浏览器场景通过、12 项按项目设计跳过，依赖审计 0 vulnerabilities，Pages 产物 28 文件/18,716,162 字节，仓库检查通过。
- 全量浏览器回归包含桌面、Pixel 5 移动、355px 窄屏、440px 阔折叠、844px 横屏和 740px 紧凑横屏；发布元数据测试确认 `build-meta.json` 的 commit、缓存名和预缓存哈希与 `sw.js`/页面契约一致。
- 质量门禁之外的独立 Claude 只读分析和审阅均因上游 API 重试超时，分别留下 `research/claude-analysis.md` 与 `research/claude-review.md`，未修改产品代码，也没有给出“通过”结论；本地静态、单元和浏览器证据完整，因此未把外部审阅超时报成产品失败。
- Pages #102（run `30999443927`，commit `05b47a4`）失败，quality job 的唯一实际阻塞是 `actions/setup-python@v5` 的 Node.js 20 deprecation warning；deploy 未启动。已核实官方 `setup-python@v7.0.0`/`node24` 并修正 workflow，等待下一次独立 Pages run。

待补充：

- 发布前置检查与 Pages 产物元数据；
- Service Worker 资源契约和旧 Worker 升级；
- 桌面/移动播放结束、模式、隐藏、延迟、自动播放失败；
- 搜索去重、空页、失败重试、旧请求和触摸滚动；
- 诊断脱敏；
- 完整 `npm run verify`；
- Claude 只读审阅；
- 独立提交、推送、Pages 成功和线上 CDP 验收。
