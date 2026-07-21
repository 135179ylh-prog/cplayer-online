# Verification - 响应式与无障碍一致性

## 验证结论

2026-07-22 完成。四种目标视口的响应式、键盘、焦点、触控尺寸与 Axe 自动检查均通过；完整八层质量门禁通过。没有调用真实 ChKSz 服务，没有改存储格式、推送或部署。

## 自动验证

| 命令 | 结果 |
| --- | --- |
| `npm run build:css` | 通过；提交产物与 Tailwind 输入同步 |
| `npm test` | 10/10 单元测试通过 |
| `npm run check:module` | 主模块语法通过；`RECENT_HISTORY_KEY` 仅 1 处定义 |
| `npm run check:sw` | Service Worker 语法通过 |
| `npm run check:features` | 静态功能与响应式契约通过；缓存版本为 `cplayer5-v55-responsive-accessibility` |
| `npm audit`（由 `npm run verify` 执行） | 0 个漏洞 |
| `npm run verify`，`PW_PORT=4174` | 8/8 层通过；浏览器 80 个用例中 78 通过、2 个按设计跳过 |
| `git diff --check` | 通过；只有 Git 的 LF/CRLF 提醒，无空白错误 |

## 浏览器矩阵

| 项目 | 视口 | 响应式/无障碍专项结果 | 覆盖重点 |
| --- | --- | --- | --- |
| desktop-chromium | `1280x800` | 7 通过，1 跳过 | 桌面侧栏、标签键盘、弹窗栈、进度、动态歌曲、Axe |
| mobile-chromium | `390x844` | 8/8 通过 | 常见手机布局、底部面板、封面/歌词切换、44px 目标、Axe |
| narrow-mobile-chromium | `355x800` | 8/8 通过 | 最窄目标屏、控件边界、两行底部控制区、Axe |
| wide-foldable-chromium | `440x707` | 8/8 通过 | 宽折叠屏布局、控件边界、弹窗和面板、Axe |

专项合计 32 个用例：31 通过，1 个桌面项目中的移动视图切换用例按设计跳过。完整套件的另一个跳过项是移动项目的离线壳重载；该 Service Worker 契约只需在一个桌面 Chromium 上验证，桌面用例已通过。

Axe 对四个项目的主界面和打开后的设置弹窗执行扫描，critical/serious 违规均为 0。外部搜索与歌曲接口只在 Playwright 网络边界模拟。

## 回归与修复证据

首次完整门禁结果为 77 通过、2 跳过、1 失败。失败可连续 3/3 复现：桌面标签用方向键切到“搜索”后，延迟的搜索框自动聚焦覆盖了标签焦点。

修复后，桌面“标签方向键切换”和“搜索歌曲主按钮键盘触发”各重复 3 次，共 6/6 通过；随后重新执行完整门禁，最终 78 通过、2 跳过、0 失败。

## 视觉检查

已检查以下首屏截图，未见整页横向裁切、控件重叠或按钮文字竖排：

- `output/playwright/responsive-a11y/after-1280.png`
- `output/playwright/responsive-a11y/after-390.png`
- `output/playwright/responsive-a11y/after-355.png`
- `output/playwright/responsive-a11y/after-440.png`

## 已知提醒与回退

- Tailwind 构建提示 `caniuse-lite` 数据可更新，但不影响构建或门禁结果；本任务不做无关依赖升级。
- 尚未在实体手机上做读屏手测；当前证据是四视口 Chromium、键盘交互、几何检查和 Axe 扫描。
- 本任务没有数据迁移。需要回退时可还原本任务提交，并恢复前一版 Service Worker 缓存名。
