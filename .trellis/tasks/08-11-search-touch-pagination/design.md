# Design - 触摸拖动触发搜索分页

## 根因

搜索 pager 的 `pointerdown` 为避免程序化滚动抢跑，会忽略从 `button`、`a` 或输入框开始的指针按下；但当前没有对应的 `pointermove` 监听。手机用户通常从歌曲行按钮区域开始滑动，若浏览器只派发 Pointer Events 而没有可用的 `touchmove`，滚动到底部后 `userScrollIntent` 仍为假，自动分页不会执行。

## 方案

- 在 pager 内增加 `pointermove` 监听。
- 仅当指针是触摸类型或存在按键按下状态时标记真实用户滚动意图；不把普通程序化 `scroll` 当作意图。
- 在 cleanup 中移除该监听，保持现有生命周期边界。

## 数据流

```text
歌曲按钮区域 pointerdown（被安全忽略）
  -> pointermove(pointerType=touch, buttons>0)
  -> userScrollIntent=true
  -> scroll 到底部
  -> loadNext(offset=30)
```
