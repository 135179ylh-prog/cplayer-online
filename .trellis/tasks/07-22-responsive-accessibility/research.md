# Research - 响应式与无障碍一致性

## 2026-07-22 基线审计

### 浏览器证据

- Playwright CLI 在 `355x800` 打开当前 `v32` 页面。
- `documentElement.scrollWidth === clientWidth === 355`，当前没有整页横向滚动。
- 移动设置弹窗打开后 `document.activeElement === #mobileSettingsBtn`，说明焦点仍在背景；按 Esc 后弹窗继续可见。
- 关闭状态的 `#mobilePlaylistSheet` 仍在页面快照中暴露关闭按钮和两个标签页。
- 移动空队列首屏可见触控尺寸不足项：设置按钮 `32x40`、上一曲 `39x56`、播放 `22x64`、下一曲 `39x56`、面板关闭 `32x40`、两个面板标签 `72x34`。
- `#mobilePlaylistToggleBtn` 的右边界到 360px，超出 355px 视口 5px；根节点因 `overflow-x:hidden` 未滚动，但控件被裁切。
- 视觉截图 `output/playwright/responsive-a11y/before-355.png` 显示底部 8 个操作挤在一行，“随机 / 清空 / 歌单”被压成狭窄竖排。

### 源码证据

- `openSettings()` 只展示弹窗，不记录/移动焦点；`closeSettings()` 不返回焦点；没有设置弹窗 Esc 处理。
- `openAddToPlaylistModal()` / `closeAddToPlaylistModal()` 没有焦点管理或 Esc。
- 音乐资料库和歌单详情分别注册 document Esc 监听，存在嵌套层同时响应同一按键的风险。
- 桌面侧栏与移动底部面板只改变 transform class，没有 `aria-hidden`、inert 或 `aria-expanded` 同步。
- 桌面和移动进度容器只有 click 监听；桌面音量 range 没有可读名称。
- 桌面/移动标签缺少完整 tablist/tabpanel 关系和统一方向键行为。
- 动态桌面/移动队列与搜索结果把整行 `div.onclick` 当作播放动作，键盘无法触发；行内另有独立按钮。
- `MobileUIManager` 查询 `#mobileViewToggle` 并绑定点击，但 HTML 没有这个元素；封面与歌词页未同步 `aria-hidden`。

## 设计结论

- 这些问题共同源于缺少统一的“当前交互层”状态，不应继续给每个弹窗追加独立 document 监听。
- 覆盖层用栈解决焦点、背景 inert 和 Esc 优先级；侧栏/底部面板保持非模态，但使用同一套可见性属性。
- 移动底栏必须先重排结构，再谈单个按钮尺寸；单纯设置 min-width 会继续溢出。
- 自动回归只让新增窄屏/折叠屏项目运行专用布局测试，避免把所有数据/PWA 用例重复四遍。
