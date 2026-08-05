# Research - 发布可追踪与手机可靠性冲刺

## 基线证据（2026-08-05）

- `HEAD` 与 `origin/main` 均为 `25e7d24`；当前工作树只有用户已有的 5 个未提交文件，均位于 `07-25-playlist-trash-history` 任务目录。
- 上一阶段线上已经确认页面就绪、Service Worker 已激活、缓存为 `cplayer5-v83-reliability-sprint`，并验证云同步修复已传播。
- `pages.yml` 当前使用 `actions/checkout@v4`、`setup-node@v4`（Node 22）、`setup-python@v5`、`configure-pages@v5`、`upload-pages-artifact@v3`、`deploy-pages@v4`；需要用官方资料确认是否存在仍依赖 Node.js 20 的 action。
- `build-pages-artifact.mjs` 当前只复制运行时文件并返回文件数/字节数，没有 commit 元数据，也没有从构建输入自动派生预缓存契约。
- 移动生命周期和自动播放失败已有较完整的 Playwright 场景；本阶段重点是确认它们覆盖真实发布产物、网络延迟、重复结束事件和移动触摸滚动，并把缺口变成可重复测试。
- 本机没有发现 `adb`、Android emulator、Flutter 或 Appium；可执行的真实浏览器替代方案是 CDP 直连 Chrome、Playwright Pixel 5 项目、页面生命周期模拟、离线/联网切换和 `play()` 拒绝注入。

## 官方 Action 核查结果

- `https://github.com/actions/checkout/releases`：最新主版本为 `v7.0.1`，主分支 `action.yml` 使用 `node24`。
- `https://github.com/actions/setup-node/releases`：最新主版本为 `v7.0.0`，主分支 `action.yml` 使用 `node24`。
- `https://github.com/actions/setup-python/releases`：最新主版本为 `v7.0.0`；v6.0.0 的发布说明已升级到 Node 24，主分支 `action.yml` 使用 `node24`。
- `https://github.com/actions/configure-pages/releases`：`v6.0.0` 的发布说明明确为 upgrade to node 24。
- `https://github.com/actions/upload-pages-artifact/releases`：最新主版本为 `v5.0.0`，内部固定 `actions/upload-artifact@v7`。
- `https://github.com/actions/deploy-pages/releases`：最新主版本为 `v5.0.0`，发布说明明确更新到 Node.js 24；GitHub.com 的 README 仍以 v4 为通用示例，但 v5 是当前发布版本。

因此 workflow 从旧组合升级到 checkout v7、setup-node v7、setup-python v7、configure-pages v6、upload-pages-artifact v5、deploy-pages v5；项目构建本身仍支持 Node.js 22+。

第一次 Pages #102 验收暴露了遗漏：`setup-python@v5` 仍触发 GitHub 的 Node.js 20 弃用警告并使 quality job 失败。已按官方 release/action.yml 核查改为 `setup-python@v7`，不能把“其他 action 已升级”误当成整个 workflow 已完成。

## 本阶段实现发现

- 之前质量门禁只检查缓存名数字至少为 v83，不能证明预缓存资源没有变化。现在 `scripts/pages-contract.mjs` 计算 14 个实际核心文件的 SHA-256，并要求 `sw.js` 内的 `PRECACHE_REVISION` 完全匹配；Pages 构建失败时不会上传不一致产物。
- Pages 构建新增公开 `build-meta.json`，由 `GITHUB_SHA` 或 Git HEAD 写入 commit，线上可直接读取，不需要把 API 配置或用户数据放入元数据。
- 移动播放和歌手搜索的现有回归已经覆盖本阶段验收边界；本轮没有重复改写已稳定的播放状态机，而是把它们绑定到同一份 Pages 产物进行回归。
- Claude 只读分析命令运行 124 秒超时且未写入文件；不影响本地测试和主线实现，后续改用更短的独立审阅入口。

## 待确认问题

1. GitHub 官方 Pages action 当前推荐版本及其 Node runtime。
2. 预缓存清单适合以静态生成文件、导出模块还是测试契约实现，才能避免构建产物和 `sw.js` 发生双份维护。
3. 线上是否能通过公开 `build-meta.json` 与页面/SW 状态证明本次 commit 已传播。
