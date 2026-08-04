# Design - 动画 WebGL 就绪探针稳定性

## 根因

测试在播放提交后立即读取 WebGL 能力与 `CURRENT_PROGRAM`。浏览器可能已经报告上下文支持，但 FluidBackground 的程序初始化尚未在同一采样点完成，导致 `supported=true`、`appHasProgram=false` 的偶发红灯。

## 方案

- 首次读取 `supported` 作为环境分支。
- 仅在支持 WebGL 时，用 Playwright 条件等待确认应用画布出现当前程序。
- 保持等待上限；超时仍报告真实失败，不把断言改成永久重试或跳过。

## 不变合同

- 后续必须仍验证可见播放有一个递归动画回调。
- 暂停、隐藏和 reduced-motion 必须停止递归视觉工作。
- 无 WebGL 环境继续验证无递归动画但音频可用。
