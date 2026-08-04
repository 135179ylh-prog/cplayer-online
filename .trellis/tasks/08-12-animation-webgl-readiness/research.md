# Research - 动画 WebGL 就绪探针稳定性

## 证据

- 动画用例重复 20 次（桌面 20、手机 20）时出现 1 次桌面失败。
- 失败发生在 `runtime-background-resilience.spec.mjs:588`：`supported=true`，但即时读取 `appHasProgram=false`。
- 其余 39 次通过；失败没有进入后续循环断言，说明红灯落在初始化采样边界，而非已观察到两个产品循环。
- 既有测试已经对正向帧数使用有界条件等待；本轮只补齐 WebGL 程序就绪这一处同类边界。

## 风险

- 等待过长会掩盖初始化失败；等待必须有明确上限。
- 只等待 `supported` 不足以证明应用画布已可绘制；必须检查应用自己的 `CURRENT_PROGRAM`。
