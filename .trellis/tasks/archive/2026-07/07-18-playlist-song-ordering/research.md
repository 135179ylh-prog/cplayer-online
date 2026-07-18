# Research - 自建歌单歌曲排序

## Existing Evidence

- `index.html` 的 `listUserPlaylists()` 从 IndexedDB `playlists` 读取 `user_pl_` 记录，并保留 `songs` 数组。
- `saveUserPlaylistRecord()` 使用同一 object store 的 `put()` 写回 `{ id, name, songs, timestamp }`。
- `refreshMyPlaylists()` 已渲染“管理”按钮，但当前调用的 `openPlaylistDetail()` 没有定义，形成未完成入口。
- `loadUserPlaylistIntoQueue()` 使用记录中的 `songs` 顺序加载队列，因此播放整单无需新增排序格式。

## Decision

以 `songs` 数组为排序源，在每次移动/删除前按 id 重新读取记录，再保存完整记录。详情视图采用现有单页内联 DOM 和 Font Awesome 图标风格，不引入框架或新依赖。

## Risks

- 单文件脚本存在历史重复事件委托，新增绑定必须使用唯一选择器并避免重复触发。
- IndexedDB 保存失败需要保留详情状态并给出反馈，不能静默显示未持久化的顺序。
- 旧歌单可能缺少封面或艺术家字段，渲染必须使用文本节点/转义并保持布局稳定。

## Peer Analysis Status

受保护的 Claude 只读终端在就绪探针阶段连续返回 502/503 与供应商熔断，未产生可采信分析。诊断保存在 `research/claude-analysis-unavailable-01.md`；未放宽权限或修改供应商配置，本轮由 Codex 独立实现和验证。

## Browser Evidence

- Playwright 移动视口验证了“歌单 → 管理”入口、首尾禁用、上移/下移、移除和歌曲计数刷新。
- 按用户要求切换到 `web-access`，通过真实 Chrome CDP 复验设置页管理入口和 IndexedDB 往返。
- Chrome 中下移后 UI 与存储均为 `Two, One, Three`，带查询参数刷新页面后详情顺序仍一致。
- 真实浏览器暴露出扩展注入 `.modal-backdrop { display:none !important; }` 的冲突；应用类名专用化后弹窗计算样式恢复为 `display:flex`。
- 视觉证据：`research/chrome-detail.png`。
