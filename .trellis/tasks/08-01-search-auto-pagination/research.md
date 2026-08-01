# Research - 搜索结果自动分页

## 现状证据

- `MusicService.searchPage()` 已请求 `limit=30` 与 `offset`，并由 `normalizeSearchPage()` 解析 `total`、`nextOffset`、`hasMore`。
- 桌面 `#searchResults` 与手机 `#mobileSearchResults` 都是独立的滚动容器，但都调用共享 `createSearchResultPager()`。
- 当前 pager 只在“加载更多”按钮点击时调用 `loadNext()`，因此用户不点击按钮时会停在首屏 30 首。
- 现有浏览器测试已覆盖分页、后续页失败重试、旧查询竞态和两个视口；本任务在此基础上增加滚动触发证据。

## Linux.do 主题可借鉴部分

- 搜索、歌曲详情、歌词和播放流分层，便于错误定位。
- 统一歌曲元数据字段和 API 错误边界。

## 明确不采用部分

- Flask 服务端代理与音频 Range 代理：GitHub Pages 无常驻后端，且会改变当前本机密钥约束。
- 固定 `limit=30` 且不分页的搜索实现：正是本次用户体验问题的来源。

## 2026-08-02 CI 竞态证据

- GitHub Actions 运行 `30707910689` 的本地质量门禁和 209 个浏览器用例通过，只有手机端“旧查询迟到响应”用例失败。
- 失败日志显示 Playwright 点击“加载更多”前先滚动按钮入视口；该程序滚动触发了自动分页，按钮被替换为禁用的“加载中…”，最终点击超时。
- 根因不是 API 或旧查询保护，而是把任意 `scroll` 事件误当成用户滚动意图。修复后自动分页只在 wheel/touch/pointer/分页键事件建立意图，再消费接近底部的 scroll 状态。
