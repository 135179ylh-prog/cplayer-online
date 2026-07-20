# Research - 搜索与歌单操作体验修复

## 复现证据

- 本地 `http://127.0.0.1:4173/` 的真实 Chrome target 中，打开搜索侧栏并弹出“加入歌单”后，点击歌单行会令 `#floatingPlaylistPanel` 添加 `translate-x-full`；选择弹窗仍显示。
- 同一路径中，`#playlistDetailModal` 可以被打开，但资料库操作按钮只有图标，实际触控反馈不明显。
- 移动歌曲行的 `.js-add-playlist-item` 只有 `+` 标记，源码没有对应 `onclick` 绑定；点击会落到歌曲行播放逻辑或没有收藏反馈。

## 根因

`initEventListeners` 的全局 click 监听器只判断目标是否在 `#floatingPlaylistPanel` 内。歌单弹窗是 body 下的兄弟节点，选择歌单时被误判为点击侧栏外部。`MobileUIManager` 的底部面板也有同类判断。

## 方案决策

- 用共享覆盖层命中判断修复两个关闭监听器，避免为每个按钮添加临时例外。
- 收藏成功后关闭选择弹窗但不改变搜索输入、结果 DOM 或侧栏开关状态，优化连续添加不同歌曲的高频路径。
- 保留现有 IndexedDB、歌曲规范化和详情排序实现，不引入新依赖或数据迁移。

## 证据文件

- `research/before-search-panel.png`
- `research/desktop-after.png`
- `research/library-mobile-390.png`
- `research/detail-mobile-390.png`
- `research/queue-mobile-390.png`
- `research/search-mobile-355.png`
- `research/search-desktop-1280.png`
- `research/mobile-after.png`（v29 响应式主界面补充证据）
- `research/search-mobile-v30-355.png`（v30 移动搜索空结果状态补充证据）
