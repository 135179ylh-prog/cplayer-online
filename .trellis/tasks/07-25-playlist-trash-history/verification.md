# Verification - 删除回收站与历史版本

## 本地自动化证据

| 日期 | 命令 | 结果 |
| --- | --- | --- |
| 2026-07-25 | `npx playwright test tests/e2e/playlist-crud.spec.mjs --project=desktop-chromium --project=mobile-chromium` | 12/12 通过；覆盖未登录回收站、刷新恢复、永久删除、30 天清理、历史预览与恢复。 |
| 2026-07-25 | `npx playwright test tests/e2e/account-cloud-sync.spec.mjs --project=desktop-chromium --project=mobile-chromium` | 26/26 通过；覆盖离线恢复、跨设备历史、永久删除标记及原账号同步回归。 |
| 2026-07-25 | `npx playwright test tests/e2e/storage-resilience.spec.mjs --project=desktop-chromium --project=mobile-chromium` | 20/20 通过；覆盖 v5→v6、v6/v7 versionchange、blocked、quota 和多页面冲突。 |
| 2026-07-25 | `npx playwright test tests/e2e/responsive-accessibility.spec.mjs` | 55 通过、11 按屏幕条件跳过、0 失败；六种视口均执行。 |
| 2026-07-25 | `npm test` | 39/39 通过。 |
| 2026-07-25 | `npm run check:features` | 通过；build badge v32，核心资源 14。 |
| 2026-07-25 | `python scripts/check_module_syntax.py` | 通过；直接检查 `js/app.js`。 |
| 2026-07-25 | `npm run build:css` | 通过；`css/tailwind.css` 已按最终 HTML/JS 重建。 |
| 2026-07-25 | `git diff --check` | 通过；只有 Git 的 LF→CRLF 工作区提示，无空白错误。 |
| 2026-07-25 | 首次 `npm run verify` | 前 8 层通过；浏览器层 188 通过、12 跳过、4 失败。失败均为历史空滚动区缺少键盘访问，未计为完整通过。 |
| 2026-07-25 | 修复后聚焦六视口 Axe/焦点用例 | 6/6 通过；历史列表与预览区已可通过键盘进入。 |
| 2026-07-25 | 修复后完整 `npm run verify` | 10/10 层通过；39 单元测试、192 浏览器测试通过、12 按条件跳过、0 失败；依赖漏洞 0；Pages 产物 27 文件、18,616,753 字节。 |
| 2026-07-25 | 首次 `npm run check:rollback -- origin/main` | 拒绝旧目标，但先被相同的 Supabase vendor 动态语法阻断，尚未到达 DB 版本比较；随后已补精确哈希门禁。 |
| 2026-07-25 | owner/snapshot 隔离聚焦测试 | 单元 14/14、永久删除 owner 隔离桌面/手机 2/2、跨歌单 `server-1` 隔离桌面/手机 2/2 通过。 |
| 2026-07-25 | 修复隔离后完整账号与本地回收站套件 | 账号 28/28、本地回收站/历史 12/12 通过。 |
| 2026-07-26 | 隔离修复后的最终 `npm run verify` | 10/10 层通过；40 单元测试、194 浏览器测试通过、12 按条件跳过、0 失败；依赖漏洞 0；Pages 产物 27 文件、18,619,847 字节。 |
| 2026-07-26 | Claude 只读独立审查 | 两次均未产生 verdict：首次 300 秒超时，第二次达到 12 轮只读工具上限；无具体发现。按失败关闭记录，未宣称 Claude 通过；诊断见 `research/claude-review-timeout-1.md` 与 `research/claude-review.md`。 |
| 2026-07-26 | `npm run check:rollback -- HEAD` | 通过；目标提交 `7121f1b`，current v6 / target v6。 |
| 2026-07-26 | `npm run check:rollback -- origin/main` | 按预期拒绝；明确识别 current v6 / target v5 不安全降级。 |
| 2026-07-26 | 回退守卫修复后的最终 `npm run verify` | 10/10 层通过；41 单元测试、194 浏览器测试通过、12 按条件跳过、0 失败；依赖漏洞 0。 |

## 已验证的关键合同

- 未登录时回收站与历史完整可用，不依赖 Supabase。
- 普通删除保留名称、歌曲和删除时间；永久删除清空内容并保留最小云标记。
- 离线恢复和永久删除进入 owner-scoped outbox，待同步数量由现有状态中心真实统计。
- 历史快照最多 20 个、最长 90 天；恢复前的当前版本仍可追溯。
- ChKSz API 密钥/API 地址、队列、最近播放和播放进度未进入歌单或历史云 payload。
- IndexedDB v5→v6 是追加升级，队列与已有歌单无损保留；回退必须保持 DB v6。

## 尚未完成

- Supabase 生产迁移及迁移后安全检查。
- 独立提交、推送与 GitHub Actions quality/deploy 验证。
- 线上真实桌面 Chrome 与实体手机跨设备验收。
