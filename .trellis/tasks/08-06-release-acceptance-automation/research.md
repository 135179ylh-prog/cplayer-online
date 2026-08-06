# 研究记录：发布验收自动化与门禁分层

## 侦察发现

1. 五类回归（后台切歌、搜索分页、重试、旧请求污染、脱敏诊断）在
   `desktop-chromium` 和 `mobile-chromium` 下都会跑；只有四个特殊视口 project 带
   `testMatch` 限定在 `responsive-accessibility.spec.mjs`。没有单视口盲区。
2. 薄弱点三处：
   - 旧请求污染只覆盖"旧查询第二页迟到"，不覆盖"旧查询首页迟到"。
   - 分页重试测试不记录 offset，重放首页或跳页都能通过。
   - 健康报告脱敏只断言内存对象，从未走真实 download 路径。
3. 隐藏态切歌用例密度最高（9 个），但全部只断言媒体元素和 MediaSession，
   没有断言隐藏切歌后可见的 now-playing UI。
4. 历史直接 CDP 验收的字段清单完整，但仓库里没有任何 CDP 脚本，也没有记录
   启动命令、端口或临时目录，每轮都要重新手工搭。
5. `npm run verify` 的浏览器层实测 8 分钟以上，是外层超时误判的唯一高危层。

## 线上环境实测

- 从本机到 Pages 的下发很慢：`js/core-utils.js` 1.9s、`js/cloud-sync.js` 6.5s、
  `webfonts/fa-solid-900.woff2` 17.4s。
- 首次实现用 90s 共享预算，第一轮轮询就把预算耗尽，reload 轮次拿到 0 预算，
  报成 "never became evaluable"。改为每次等待独立计时（240s）后通过。
- `--headless=new`、`--headless`（旧）、`--no-proxy-server` 三种组合都能让页面
  就绪，说明不是 headless 模式问题，而是超时模型问题。
- 求值表达式里 `navigator.serviceWorker` 在页面 `loading` 早期可能为 undefined，
  必须先取 container 再判空，否则前几轮抛 TypeError 而不是返回未就绪。

## 重试游标的真实行为

传输层 `API_REQUEST_RETRIES = 1`，对 5xx 会自动重试一次，所以"手动点重试"在
网络层看到的失败游标请求次数是 3 而不是 2。断言改为：首页恰好一次、其余请求
全部落在失败游标上，这样既锁住"不重放首页/不跳页"，又不把传输层重试写死。

## 基线证据（修复前的线上状态）

`npm run check:release --no-browser` 对 `825044d` 全部通过：commit
`825044dc566330ff4393e242cbc7b9fb448aa3e4`、缓存 `cplayer5-v85-reliability-sprint`、
预缓存哈希 `sha256:91f5909507c18acc62f7b5fd96eae0cfd6adcbf472d23b30cb85dfb99313077a`，
线上重算哈希与公开值一致。带 CDP 的完整核对同样通过，页面 `ready=true`、
Worker `activated`、CacheStorage 仅 `cplayer5-v85-reliability-sprint`、核心资源 14/14。
