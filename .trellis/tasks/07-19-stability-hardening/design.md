# Design - 播放器稳定性加固

## 网络请求

`fetchJsonWithTimeout` 统一负责 15 秒超时、HTTP 状态检查和 JSON 解析。搜索页面各自维护单调递增请求编号；只有当前编号可以写入结果 DOM，旧请求完成后直接丢弃。

## 队列持久化

队列保存使用单个进行中的 IndexedDB 事务。保存期间发生的新变更只记录一个待保存原因，前一事务结束后再读取当前最新队列写入。250ms 防抖仍保留；`visibilitychange=hidden` 和 `pagehide` 会取消定时器并立即开始保存。

`current_queue.songs` 允许空数组。存在合法记录即视为恢复成功，避免继续读取旧 `cp_playlistId`。清空和 JSON 导入都会清除旧在线歌单 ID，防止来源回跳。

## 移动端同步与渲染

初始化后把 `MobileUIManager` 实例同时保存到模块变量和 `window.mobileUI`，满足现有共享队列函数的调用约定。移动搜索按钮使用箭头函数保留实例 `this`。

外部歌曲名称继续以 DOM `textContent` 或 `escapeHtml` 渲染，不允许 API/导入数据改变元素结构。

## PWA 缓存

- 核心资源逐项以 `cache: reload` 获取；失败时尝试从旧缓存复制，仍缺失则让新 Service Worker 安装失败并保留旧版本。
- 页面导航网络优先，失败回退 `index.html`。
- 只有播放器根路径或 `index.html` 导航可以刷新离线壳，其他同域页面不得覆盖 `index.html` 缓存。
- 网易封面缓存分支先于音频直连分支，最多保留 160 条；核心资源不参与封面淘汰。
- 空的 `playlist.js` 作为可替换入口纳入核心缓存，消除默认 404。
