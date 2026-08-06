# 验证：发布验收自动化与门禁分层

## 状态

本地实施与完整门禁已通过；提交、推送、Pages 部署和线上核对记录见下方"发布记录"。

## 保护性基线

- 基线提交：`825044d`。
- 用户已有未提交改动：`.trellis/tasks/07-25-playlist-trash-history/` 下 3 个文档和
  2 张截图，共 5 项；本阶段未暂存、未覆盖、未删除。
- 未改动任何歌单数据、IndexedDB schema 或云端接口。

## 本地结果

| 检查 | 结果 |
| --- | --- |
| `node --test tests/release-preflight.test.mjs` | 通过：26/26（原 17，新增 9 项发布自动化回归） |
| `python tests/verify_features.py` | 通过；新增分层门禁、线上核对、四个 package 脚本和三处回归标题契约 |
| `npm run build:pages` | 通过：28 个文件、18,709,467 字节；缓存 `cplayer5-v85-reliability-sprint`；预缓存哈希 `sha256:91f5909507c18acc62f7b5fd96eae0cfd6adcbf472d23b30cb85dfb99313077a` |
| 健康报告真实下载脱敏回归 | 通过：桌面/手机各 1 项；下载文件与内存报告完全相同，且不含密钥、地址、队列、历史、账号身份 |
| 搜索旧首页污染与重试游标回归 | 通过：桌面/手机 18/18；首页只请求一次，重试只打失败游标 |
| 隐藏态切歌可见 UI 回归 | 通过：桌面/手机 2/2；`#songTitle`/`#songIdTag` 与移动端标题、艺人均切到已提交歌曲 |
| 完整 `npm run verify`（最终代码树） | 通过：10/10 层；56/56 单元；浏览器 270 通过、12 项按设计跳过；依赖审计 0 vulnerabilities；仓库检查通过；浏览器层 734.8s |

单元测试从 47 增至 56，浏览器场景保持 270 通过 + 12 按设计跳过，覆盖没有下降。
核心运行时资源未改动，所以预缓存哈希与基线一致，属预期。

## 分层门禁的真实中断验证

不是模拟，而是真实杀进程后观察分类：

1. 完整门禁运行到浏览器层时，用外部命令结束了 gate 及其 Playwright 子进程。
2. `npm run verify:status` 显示 1-8 层 `passed`、第 9 层 `interrupted`，并提示
   "were interrupted by an outer timeout, not by a test failure"。这正是本轮要
   消除的误判：外层结束进程不再被报成测试失败。
3. `npm run verify:resume` 打印 "8 step(s) already passed, 2 remaining"，只重跑
   未完成的两层，没有减少任何测试。
4. 首次 resume 因被杀的运行留下占用 4173 端口的孤儿测试服务器而失败（Playwright
   报 "already used"），不是产品或测试缺陷。清理该进程后重跑通过。
5. 最终一次完整门禁本身也超出了外层 600s 限制被转入后台，但门禁进程自己跑完并
   写下 10/10 `passed`，证明状态文件与日志在外层超时下仍然可信。

## 修复过程中的失败记录

- 线上 CDP 首次实现用 90s 共享预算，第一轮轮询就耗尽预算，reload 轮次拿到 0
  预算，误报 "never became evaluable"。实测本机到 Pages 下发很慢
  （`webfonts/fa-solid-900.woff2` 17.4s、`js/cloud-sync.js` 6.5s），改为每次
  等待独立计时（默认 240s）后通过。
- `--headless=new`、旧 `--headless`、`--no-proxy-server` 三种组合都能让页面就绪，
  确认不是 headless 模式问题，而是超时模型问题。
- 求值表达式里 `navigator.serviceWorker` 在页面 `loading` 早期可能为 undefined，
  前几轮抛 TypeError；改为先取 container 再判空。
- 重试游标断言最初写成精确数组 `[0, 30, 30]`，实际为 4 次请求：传输层
  `API_REQUEST_RETRIES = 1` 对 5xx 会自动重试一次。改为断言"首页恰好一次、其余
  请求全部落在失败游标上"，既锁住不重放首页/不跳页，又不把传输层重试写死。
- `check-features` 的十层 id 契约初版正则 `[a-z-]+` 漏掉了含数字的 `test-e2e`，
  已修正为 `[a-z0-9-]+`。
- 最终门禁第一次启动时把日志写到未被忽略的 `output/gate-final.txt`，第 10 层会
  把它当作未跟踪文本检查。改为写入被 `*.log` 规则忽略的路径。
- 顺带消除 `spawn` 的 DEP0190 警告：新增 `resolveNpmCommand()`，优先用本 Node
  执行 npm 自带 CLI，不再在 Windows 上带 shell 拼接参数。

## 线上核对（基线 `825044d`，修复前）

`npm run check:release` 对当时线上站点 5/5 通过：

- `build-meta.json` 契约、线上 `sw.js` 与元数据一致、`index.html` 构建标记存在。
- 按线上实际下发字节重算预缓存哈希，与公开值一致（这一项是"部署成功但字节不是
  那份产物"的真正判据）。
- 直接 CDP 运行时证据：`ready=true`、Worker `activated`、CacheStorage 仅
  `cplayer5-v85-reliability-sprint`、核心资源 14/14。

临时 CDP Chrome 与临时配置目录均已清理，核对后 `cplayer-release-cdp-*` 残留数为 0，
未连接浏览器扩展，未操作用户任何标签页。

## 发布记录

| 步骤 | 结果 |
| --- | --- |
| 独立提交 | 待填 |
| 推送 `main` | 待填 |
| Pages quality / deploy | 待填 |
| `npm run check:release -- --commit=<新 commit>` | 待填 |

## 记录规则

只记录命令、视口、通过/失败数量和脱敏的公开发布证据；不记录 API 凭据、token、
账号 ID、完整音频 URL、歌单内容或播放进度。
