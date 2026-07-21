# Design - 响应式与无障碍一致性

## 1. 覆盖层栈

新增页面内唯一的覆盖层管理器，维护按打开顺序排列的弹窗栈：

```text
openAccessibleOverlay(modal, close, initialFocus)
  -> 记录当前焦点
  -> 将弹窗压入栈顶
  -> 让 body 其他直接子节点 inert
  -> 聚焦弹窗内指定控件

document keydown
  -> Tab: 只在栈顶弹窗的可聚焦元素中循环
  -> Escape: 只调用栈顶弹窗的 close

closeAccessibleOverlay(modal)
  -> 从栈移除
  -> 恢复下一层或页面的 inert 状态
  -> 把焦点还给该弹窗的打开入口
```

`inert` 同时阻止指针、键盘和可访问树进入背景，比逐个改 `tabindex` 更可靠。首次打开时记录 body 子节点原有 inert 状态，最后一层关闭时原样恢复。设置和欢迎弹窗保留动画，在隐藏完成后才出栈。

## 2. 非模态面板

桌面侧栏和移动底部面板不是模态框，不进入覆盖层栈。它们共享以下状态契约：

- 关闭：`aria-hidden="true"`、`inert=true`、入口 `aria-expanded="false"`。
- 打开：移除 inert、`aria-hidden="false"`、入口 `aria-expanded="true"`，焦点移到当前标签。
- Esc：没有弹窗打开时，关闭当前可见面板并返回入口。
- 标签切换：更新 `aria-selected`、roving `tabindex`、tabpanel 隐藏和 inert。

弹窗优先级高于面板。加入歌单弹窗从侧栏打开时，侧栏保持视觉状态但因背景 inert 暂时不可操作；弹窗关闭后回到原按钮。

## 3. 原生交互语义

- 进度条继续沿用现有视觉 DOM，在外层增加 `role="slider"`、`tabindex="0"` 和动态 `aria-valuenow/aria-valuetext`。
- 新增共享的进度语义同步与键盘跳转函数，桌面和移动调用同一实现。
- 队列和搜索歌曲行改成“容器 + 主播放 button + 独立操作 buttons”，避免给包含按钮的整行添加伪 button 角色。
- 歌词行没有嵌套操作，可使用 `role="button"`、`tabindex="0"` 和 Enter/Space 激活。
- 移动页头增加现有代码已预留的 `#mobileViewToggle`，动态维护 `aria-pressed`、标题和可读名称。

## 4. 移动控制布局

```text
主播放行: [模式] [上一曲] [播放/暂停] [下一曲] [队列]
次操作行: [清空队列] [音乐资料库]
```

主播放行使用固定 44px 目标，播放按钮保持 64px；次操作行使用等宽 44px 按钮。删除重复的文字播放模式按钮 `#mPlayModeBtn`，播放模式仍由唯一的图标按钮控制并通过动态 `aria-label` 说明当前状态。

虚拟列表的移动行高从 58px 调整为能容纳 44px 操作的稳定高度，滚动总高度与定位继续只由同一个常量计算。

## 5. 浏览器验证结构

`playwright.config.mjs` 保留现有业务项目：

- desktop `1280x800`
- mobile `390x844`

另加只匹配 `responsive-accessibility.spec.mjs` 的项目：

- narrow mobile `355x800`
- wide foldable `440x707`

专用测试检查 DOM 几何、焦点和可访问状态；Axe 扫描禁用真实第三方网络，页面只使用空队列或本地注入的安全测试数据。外部 API 不参与通过/失败判断。

## 6. 兼容与回退

- 不改变 IndexedDB、localStorage、API 或 Service Worker 请求逻辑。
- `inert` 在目标 Chromium/PWA 环境原生支持；HTML 的 `aria-hidden` 仍作为读屏状态说明。
- 回退本里程碑只需还原 `index.html`、Tailwind 输入/产物、Playwright 配置与测试依赖；无数据迁移。
