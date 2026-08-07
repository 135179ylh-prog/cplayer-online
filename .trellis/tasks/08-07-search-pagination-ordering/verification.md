# 验证：分页乱序与离线重试回归补强

## 状态

已完成：探针测量、三类新回归（均经变异验证）、长跑假失败根治、完整门禁、
提交推送、Pages 部署与线上验收全部通过。

## 保护性基线

- 基线提交：`22d3775`。
- 用户已有未提交改动：`07-25-playlist-trash-history/` 下 5 项，全程未暂存、
  未修改、未删除。
- 本轮**未改动任何产品代码**：`js/app.js` diff 为空（含变异测试后的还原核对）。

## 结果记录

| 检查 | 结果 |
| --- | --- |
| 乱序路径探针 | 证明不可达：加载中请求恒为 `[0,30]`，控件 disabled，三层守卫均生效 |
| 变异：移除 `loadNext()` 守卫 | 抓住：游标 30 重复请求 3 次，断言失败 |
| 变异：失败时清空已加载结果 | 抓住：离线与超时两项均失败 |
| 变异：`timeout` 改回 30s | 抓住：`check:features` 报错并指出原因 |
| 变异：`retries` 改为 2 | 抓住：`check:features` 报错并指出原因 |
| `search-recovery.spec.mjs` | 18 → 24 项（桌面/手机各 12），全部通过 |
| 完整 `npm run verify` | 通过：10/10 层一次跑通；浏览器 276 通过（原 270）、12 项按设计跳过；0 vulnerabilities |
| 独立提交 | `184a98d839ce4c15829044dd9a89d07bfa2fa9ae`，8 个文件；用户原有 5 项仍未暂存 |
| Pages run `31203505100` | 通过：quality 与 deploy 均 success |
| `npm run check:release` | 通过：5/5 项 |

## 线上验收证据（`184a98d8…`）

- `build-meta.json` commit 与本地 HEAD 一致。
- 线上 `sw.js` 缓存名与预缓存哈希同公开元数据一致。
- 按线上实际下发字节重算预缓存哈希：
  `sha256:91f5909507c18acc62f7b5fd96eae0cfd6adcbf472d23b30cb85dfb99313077a`，与公开值一致。
- 直接 CDP：`ready=true`、Worker `activated`、CacheStorage 仅
  `cplayer5-v85-reliability-sprint`、核心资源 14/14。

缓存名与哈希同基线相同，因为本轮只改测试与配置，未动任何 Pages 运行时资源；
线上 commit 已推进，说明部署确为新提交产物。

临时 CDP Chrome 0 个、临时目录 0 个、4173 端口无残留；未连浏览器扩展，
未操作用户标签页。报告仅含公开字段，敏感字段扫描为 none。

## 故障与失误记录

1. **误判乱序为真 bug**：仅读 `loadNext()` 开头就下结论，未检查 UI 层守卫。
   探针测量推翻该判断，遂撤回并放弃为不可达路径加生产钩子。
2. **首版测试无效**：只断言按钮 disabled，而该状态由 `renderControl()` 独立
   控制。移除内层守卫后 12 项全过，缺陷漏过。改为直接向控件派发 click，
   绕过 disabled 打到加载处理器，使内层守卫成为唯一防线后方能抓住。
3. **首版离线测试无效**：`page.route` 的 fulfill 在网络层之前，`context.setOffline`
   拦不住它，请求根本没失败。改用 `route.abort('internetdisconnected')` 配合
   覆写 `navigator.onLine`。
4. **线上验收首次失败**：我手敲了一个不存在的完整 SHA（前 7 位对、其余编造），
   工具正确抓出不一致并拒绝放行。改用 `git rev-parse HEAD` 后 5/5 通过。
   这次失败反证了 commit 契约有效。

## 记录规则

只记录命令、视口、通过/失败数量和脱敏的公开发布证据；不记录 API 凭据、token、
账号身份、完整音频 URL、歌单内容或播放进度。
