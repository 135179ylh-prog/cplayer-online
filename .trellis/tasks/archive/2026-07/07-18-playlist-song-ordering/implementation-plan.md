# Implementation Plan - 自建歌单歌曲排序

## Steps

1. [x] 补齐任务上下文并记录现有代码证据。
2. [x] 在 `index.html` 增加详情弹窗、详情渲染和歌单操作函数。
3. [x] 将“我的歌单”及设置中的管理入口接到详情函数。
4. [x] 对上移、下移、移除、边界、空状态和保存失败做静态及浏览器验证。
5. [x] 更新根任务文档和本任务的验证记录。

## Files

- `index.html`: 自建歌单详情 UI、排序/移除逻辑和事件绑定。
- `.trellis/tasks/`: PRD、设计、研究、实施计划及验证记录。

## Verification

- `node --check _check.js`（从 `index.html` 提取内联脚本）。
- `python verify_features.py` 或等价静态断言。
- 本地静态服务器 + 浏览器注入测试数据，验证打开、排序、移除、刷新重读和边界按钮。
