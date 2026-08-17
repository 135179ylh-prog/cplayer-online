# 拆分 app.js 单体模块

## Goal

把 `js/app.js` 从 10271 行降到 2000 行以内，按职责拆成可独立阅读的模块，
行为完全不变。这是长期改不动这个项目的根源：单文件占全部代码 76%。

## 为什么难

顶层有 89 个模块级可变状态（`audio`、`playlist`、`currentIndex`、`db`、
`cloudSession` 等），366 个函数通过它们隐式耦合。搬错一个会出现两份状态或读到
stale 值，而且**不会立刻报错** —— 这是本任务的核心风险。

分区注释不可靠：实测「复制交互」注释后面跟着 Toast 和应用更新提示三类无关职责，
注释边界不等于真实边界。只能靠实测函数边界和状态引用。

## Requirements

1. **每步都必须有安全网**
   - 拆分前先建立能守住行为的守卫测试，并变异验证其有效。
   - 已建：`tests/e2e/module-surface.spec.mjs` 锁 26 个 `window.*` 公开接口，
     以及 `window.playlist` 必须是同一引用而非副本。
   - 两个守卫都经变异验证：删掉一个 `window.*` 赋值、把 playlist 改成副本，
     都被精确抓住。

2. **按实测耦合度选顺序，不按注释美观度**
   - 先切写 0 个共享状态的块，最后碰队列和播放。
   - 每步搬完立刻跑回归，绿了再下一步。

3. **模块边界要用契约锁住**
   - 新模块不得发布全局（`window.x = ...`）。
   - 新模块不得反向依赖应用状态（`playlist`、`currentIndex`、`cloudSession` 等）。
   - 外部依赖一律由构造参数注入。

4. **每步走完提取清单**
   - 见 `extraction-checklist.md`（6 必做步 + 2 视情况 + 已核实无需改动项）。
   - 最易漏且后果最重的是 `production_source`：漏加会造成密钥扫描盲区。

## 进度

| 步骤 | 内容 | 行数变化 | 状态 |
| --- | --- | --- | --- |
| 0 | 建立守卫测试并变异验证 | — | 完成 |
| 1 | 删除死代码（弹簧物理滚动，外部引用 0 次） | 10271 → 10215 | 完成 |
| 2 | 提取 `FluidBackground` 到 `js/fluid-background.js` | 10215 → 10015 | 完成 |
| 3 | 提取 `LyricsCanvasRenderer` 到 `js/lyrics-canvas.js` | 10015 → 9684 | 完成 |
| — | 修复顺带发现的真 bug：歌单加载失败留下过期 `window.playlist` | — | 完成 |
| 4 | 提取 `MobileUIManager` 到 `js/mobile-ui.js`（691 行） | 9684 → 9010 | 完成 |
| — | 修工具可靠性：线上验收因 Windows 文件锁 `EBUSY` 两次中断 | — | 完成 |
| 5 | 提取桌面搜索到 `js/search-view.js`（408 行） | 9027 → 8635 | 完成 |
| 6 | 提取虚拟滚动歌单视图到 `js/playlist-view.js`（227 行） | 8635 → 8409 | 完成 |
| 7 | 提取睡眠定时到 `js/sleep-timer.js`（86 行 + 4 处声明） | 8429 → 8350 | 完成 |
| — | 修用户报告的两个线上缺陷（队列不能加歌单、点播放丢搜索结果） | — | 完成 |
| 8 | 云同步状态收拢到 `js/cloud-state.js`（19 个状态 + 3 个常量） | 8350 → 8330 | 完成 |
| — | 修上游 API 换域名（作者关停境内服务，`api.chksz.top` → `api.chksz.com`） | — | 完成 |
| — | 修 CI 暴露的测试缺陷：歌词请求未 mock，换域名后打真实上游返回 401 | — | 完成 |
| 9 | 提取云同步 UI 到 `js/cloud-ui.js`（594 行） | 8330 → 7791 | 完成 |

### 换域名引发的测试缺陷（判断错误记录）

推送 `b0a956a`（换 API 域名）后 CI 在浏览器层失败，`queue-failure-paths.spec.mjs`
八项挂掉，deploy 被跳过——**该修复实际未上线**。我先前对用户说"已推送上线"是错的，
只推送成功，部署没成功。

失败信息是提示文案不符：期望"正在尝试下一首"，实际"API 密钥无效或额度已用完"。

我最初推断是路由正则匹配不上新域名，实测否定（正则只匹配路径，与域名无关）。
又推断歌词失败只 `console.warn` 不会弹提示，也错了。最后写探针打印全部出网请求，
才看到真凶：**`/163_lyric` 从未被 mock**，换域名前本机代理拦不住它所以无害，
换域名后 CI 能真正连上上游、拿到 401，`fetchJsonWithTimeout` 抛 `ApiAuthError`，
这个错误的提示抢在跳歌提示之前显示。

修复是给该 spec 加上歌词 mock（`runtime-background-resilience.spec.mjs` 一直有，
我写新 spec 时漏了）。

**诚实说明**：这个修复无法在本地变异验证。去掉歌词 mock 后本地仍通过，因为本机
走代理访问 `api.chksz.com` 会快速失败，反而掩盖了缺陷。探针实测证明歌词请求确实
出网（必要性成立），但充分性只能由 CI 判定。

教训：本地环境的网络限制会掩盖"未 mock 外部依赖"这类缺陷。新写 spec 时应比照
同类既有 spec 的 mock 清单，而不是只 mock 自己直接断言的端点。

### 第 9 步漏掉一个 import（本步最严重的失误）

跑完整门禁时 7 项云同步用例失败，提示"健康检查失败，但没有修改本机数据"。

真因：`cloudHealthStatusClasses` 搬到了 `cloud-ui.js` 并已导出，但 `js/app.js`
的 import 清单里漏了它。`renderCloudHealthSnapshot` 调用时抛
`ReferenceError`，被 `runCloudHealthCheck` 的 catch 吞掉，只留一句
`console.warn`，界面只显示笼统的失败文案。

**这正是 goal 里预警的那类缺陷**：搬错不会立刻报错，等到那条代码路径真正执行
才炸。语法检查通过、模块能加载，问题只在点"健康检查"时才出现。

排查用了探针而非读码：挂 `page.on('console')` 捕获被吞掉的 warn，一次就拿到
准确的 `ReferenceError` 和行号。

修完后我做了两件超出"改一行"的事：

1. 写一次性脚本比对 `cloud-ui.js` 的 15 个导出与 app 的 import 清单，确认没有
   第二处遗漏，也没有多余导入。脚本本身出过两个错（懒匹配吞掉了整个 import 区、
   展开语法 `...name` 被误判为属性访问），修正后结论才成立。
2. 给 `cloud-health-check.spec.mjs` 加 `collectUnexpectedErrors`。原来它只断言
   界面文案，无法暴露被吞掉的运行时错误。变异验证：删掉那行 import，测试失败。

留待后续：`account-cloud-sync.spec.mjs` 同样没有收集运行时错误，可用相同手法加固。

### 第 9 步收尾记录

搬移 594 行，`js/app.js` 8330 → 7791。注册了 `sw.js`、`scripts/pages-contract.mjs`、
`tests/e2e/release-artifact.spec.mjs` 三处清单，缓存名 v96，预缓存哈希重算两次
（加模块一次、修 import 一次）。`tailwind.config.cjs` 也必须加——该模块含 25 处
Tailwind 类名，不在扫描范围内类会被清除，且不会有任何检查报错。

契约侧：新增 `CLOUD_UI` 常量，`required_app` 的断言目标改为 `APP_RUNTIME`
（= APP + CLOUD_UI），后续再搬 cloud 函数不必逐条改断言；补了 `production_source`
（漏掉会造成密钥扫描盲区）；新增三条模块边界契约（不得重复声明共享状态、
不得发布全局、必须读共享状态），均经变异验证。

提交 `c4d662f` + `7d60a7c`；Pages run `32047906017` quality/deploy 均 success；
线上验收 5/5（核心资源 22/22，线上 API 地址已是 `api.chksz.com`）。

deploy 首次失败是 GitHub 侧 503（"No server is currently available"，错误信息
自称疑似 Pages 故障），当时 githubstatus 仍报 operational；重跑 deploy 后通过。
非本项目缺陷，但记下来：deploy 失败时改动并未上线，不可因"推送成功"就宣称上线。

**提交边界失误**：合并时用了 `git add js/app.js`，把第 9 步的代码搬移一起带进了
「修歌词 mock」提交，所以 `c4d662f` 混入 613 行 `app.js` 改动。两提交合起来内容
完整、与门禁验过的树一致，但违背了自己定的「独立提交」。已推送，不改写历史。
后续一律 `git add` 精确文件，不用宽泛路径。

第 8 步几乎不减行数，但它是必要铺垫：cloud 主题横跨约 5000 行、被非 cloud 代码
穿插，无法整块搬移。先把状态移出去，后续每次搬 cloud 函数都不再需要注入 setter。
实测依据：只搬那三段连续区时有 11 个状态需要 setter；把六段一起算则为 0。

前三步共减 587 行。这三步都是「零状态写入」的块，属于最容易的部分；剩余约 7700 行
全部涉及共享状态，必须换策略（见下）。

## Acceptance Criteria

- [ ] `js/app.js` 不超过 2000 行
- [x] 每步行为不变，`git diff` 仅含预期改动
- [x] 每步完整 `npm run verify` 十层通过
- [ ] 每步独立提交、推送、Pages 成功、线上验收 5/5
- [x] 模块边界契约经变异验证有效

## 安全约束

- 保留用户在 `07-25-playlist-trash-history/` 下的 5 项未提交改动。
- 不夹带任何逻辑修改或「顺手优化」，拆分只搬代码。
- 变异测试改动的产品代码必须全部还原并核对 diff 为空。
- 不强制推送，不改写远端历史。
