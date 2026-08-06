# 设计：发布验收自动化与门禁分层

## 1. 分层门禁（`scripts/run-quality-gate.mjs`）

原实现是十条顺序 `spawnSync`，任何一层的输出只走父进程 stdio；父进程被外部结束
时不留任何可判断的痕迹。改成：

- 导出 `STEPS`：十层各有 `id`、`label`、`args`，两层带 `guard`（生成文件必须已提交），
  `test-e2e` 带 `pagesRoot`（注入 `PW_WEB_ROOT`）。顺序和覆盖与原实现完全一致。
- 每层运行前把 `status: 'running'` 和当前 `pid` 写入 `output/quality-gate/state.json`，
  运行后写入 `passed | failed | interrupted`、退出码和耗时。
- 输出同时 tee 到 `output/quality-gate/<序号>-<层名>.log`，所以外层超时后日志仍在磁盘上。
- `expireInterruptedSteps()` 在读状态时用 `process.kill(pid, 0)` 判断拥有者进程是否还在；
  进程已消失的 `running` 层改判为 `interrupted`。这是"外层超时不等于测试失败"的落点。
- 命令行：`--list`、`--status`、`--resume`、`--only=<id,...>`、`--from=<id>`。
  `--resume` 只跳过已记为 `passed` 的层，因此不会减少任何测试。
- 只有十层全部 `passed` 才打印 `Quality gate passed.`；子集通过时明确提示仍需完整门禁。

选择 `spawn` 而不是 `spawnSync`：需要在子进程输出流上分叉写日志，`spawnSync` 拿不到流。

## 2. 线上核对（`scripts/check-pages-release.mjs`）

分成纯函数层和 I/O 层，纯函数层可被单元测试直接覆盖：

- `assertDeployedMetadata()`：`build-meta.json` 的 schema、40 位 commit、缓存名模式、
  `sha256:` 模式、预缓存资源集合，以及可选的期望 commit。
- `assertDeployedWorker()`：线上 `sw.js` 的 `CACHE_NAME`、`PRECACHE_REVISION`、
  `CORE_ASSETS` 必须与公开元数据和 `pages-contract.mjs` 一致。
- `assertRuntimeEvidence()`：页面就绪标记、构建标记、controller 是线上 `/sw.js`、
  active 为 `activated`、CacheStorage 只有本次缓存名、14 个核心资源齐全。
- `isRuntimeEvidenceComplete()`：轮询终止条件，也是"是否需要 reload 一次"的判据。

关键取证不是读公开哈希，而是重算：`pages-contract.mjs` 新增
`computePrecacheRevisionFrom(loadAsset)`，把"取字节"抽成回调，本地读文件和线上 fetch
共用同一套排序 + LF 规范化 + 分隔符逻辑。线上把 14 个核心资源全部拉一遍再算哈希，
所以"部署成功但字节不是那份产物"会被抓住。

## 3. 直接 CDP

不引入任何浏览器自动化依赖，直接用 Node 24 内置 `WebSocket` 说 CDP：

- `--headless=new --remote-debugging-port=0 --user-data-dir=<临时目录> --disable-extensions`，
  端口从 `DevToolsActivePort` 读，避免端口冲突和连到用户浏览器。
- `Target.createTarget` → `Target.attachToTarget(flatten)` → `Runtime.evaluate`。
- 首次访问时 Worker 在页面加载后才安装，所以证据不完整时 reload 一次再取，
  证明线上 Worker 真的接管了一个真实客户端。
- 每次等待各自独立计时（默认 240s）。线上 `webfonts/fa-solid-900.woff2` 单个资源
  实测可达 17s，共享一个总预算会让 reload 轮次饿死并误报失败。
- `finally` 里关 CDP socket、`kill` 浏览器（4s 后 SIGKILL）、删除临时目录。

`navigator.serviceWorker` 在页面早期可能还不存在，求值表达式先取 container 再判空，
否则第一轮 `Runtime.evaluate` 会抛 TypeError 而不是返回未就绪状态。

## 4. 回归补强

- `search-recovery.spec.mjs`：新增"旧查询首页迟到不能替换新查询结果"；重试测试
  记录 offset，断言首页只请求一次、重试只打失败游标（传输层对 5xx 会重试一次，
  所以用集合而不是精确数组断言）。
- `runtime-background-resilience.spec.mjs`：新增"隐藏态自动切歌后可见 UI 同步"，
  断言 `#songTitle`、`#songIdTag`，移动端额外断言 `#mobileTitle`/`#mobileArtist`。
- `cloud-health-check.spec.mjs`：新增真实 download 路径的脱敏回归，先写入本机
  API 密钥/地址/队列/历史，再比对下载文件与内存报告完全相同且不含任何敏感字段。

## 5. 契约

`tests/verify_features.py` 锁住：十层 id 顺序、分层门禁的关键符号、四个新
package 脚本、线上核对的 CDP 与清理边界（并断言它不读凭据字段）、
`computePrecacheRevisionFrom` 的存在、六个新单元测试标题、三处新浏览器回归标题，
以及 README 对分层门禁和线上核对的说明。
