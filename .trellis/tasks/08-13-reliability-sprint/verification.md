# Verification - CPlayer 可靠性冲刺

## 当前状态

定向修复回归已完成；完整质量门禁、发布和线上验收仍未完成。

| 范围 | 桌面 | 手机 | 结果 |
| --- | --- | --- | --- |
| 顺序模式结束切歌/列表末尾停止 | ✅ | ✅ | `runtime-background-resilience.spec.mjs` 42/42 通过 |
| 单曲循环结束重播 | ✅ | ✅ | 同上 |
| 列表循环结束回首 | ✅ | ✅ | 同上 |
| 随机模式结束切歌 | ✅ | ✅ | 同上 |
| 页面隐藏 + 网络延迟 | ✅ | ✅ | 同上 |
| 自动播放失败后恢复 | ✅ | ✅ | 同上 |
| 搜索完整总数/重复页/空页 | ✅ | ✅ | `search-recovery.spec.mjs` 16/16 通过 |
| 搜索失败重试/旧请求污染 | ✅ | ✅ | 同上 |
| 搜索触摸 Pointer Events 滚动 | ✅ | ✅ | 同上 |
| 本机播放诊断脱敏/不上传 | ✅ | ✅ | `playback-error.spec.mjs` 6/6 通过 |
| `npm run verify` | — | — | ✅ 10/10 通过；252 通过，12 按配置跳过 |
| 播放提交 Pages 工作流和线上基线 | — | — | ✅ 工作流 `30886331021` 为 `Success`；页面就绪，Service Worker `activated` |
| 搜索/诊断提交 Pages 工作流和线上验收 | — | — | 待验证 |

## 已执行命令（2026-08-04）

- `npm run check:module`：通过。
- `npm run check:features`：通过。
- `npm run test:unit`：45/45 通过。
- `$env:PW_PORT='4185'; npm run test:e2e -- tests/e2e/playback-error.spec.mjs --project=desktop-chromium --project=mobile-chromium`：6/6 通过。
- `$env:PW_PORT='4186'; npm run test:e2e -- tests/e2e/runtime-background-resilience.spec.mjs --project=desktop-chromium --project=mobile-chromium`：42/42 通过。
- `$env:PW_PORT='4187'; npm run test:e2e -- tests/e2e/search-recovery.spec.mjs --project=desktop-chromium --project=mobile-chromium`：16/16 通过。
- `npm run verify`：首次运行因生成 CSS 新鲜度保护停止；审核生成差异后重跑，10/10 通过。完整 Pages 产物回归 252/252 通过，12 个响应式场景按项目配置跳过；依赖审计 0 vulnerabilities；仓库检查通过。
- `Invoke-WebRequest http://127.0.0.1:3456/eval?target=2C55F8B5692BF8856201DB924DEA7FE4`：确认工作流 `30886331021` 页面正文为 `Success`；线上基线读取到 `readySignal=true`、Service Worker `activated`，诊断 API 在旧产物中为 `undefined`。

## 尚待证据

- Trellis 质量检查结果。
- 独立提交、推送、GitHub Pages 成功运行和线上真实浏览器验收。

## 记录规则

- 每条记录写明命令、日期、通过/失败数量和关键输出，不用“应该通过”代替证据。
- 若失败，先记录完整错误和复现路径，再按系统化调试流程修复；连续三次同一阻塞只报告具体阻塞与已尝试的安全替代方案。
- 线上验收不读取或展示 API key、API 地址、播放进度或其他敏感本机数据。
