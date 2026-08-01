# Design - 搜索结果自动分页

## 参考结论

2026-08-01 通过浏览器读取 Linux.do 主题《高颜值网易云母带级无损音乐APP开源了》（https://linux.do/t/topic/2689616）。可借鉴的是 API 分层、统一歌曲元数据和统一错误处理；主题中的 Flask 服务端代理、固定 API 地址和 `limit=30` 实现不适用于当前静态 GitHub Pages 与“密钥只存本机”的约束。

## 数据流

```text
滚动搜索结果容器
  -> 接近底部（剩余空间 <= 240px）
  -> 当前 pager 未加载、仍有下一页、没有错误
  -> MusicService.searchPage(query, { limit: 30, offset })
  -> normalizeSearchPage + mergeUniqueSearchSongs
  -> 追加歌曲并刷新进度/按钮
```

## 设计决策

- 复用现有 `createSearchResultPager`，不在桌面和手机各写一套分页逻辑。
- 在 pager 内监听当前结果容器的 `scroll` 事件，使用 240px 预加载距离；通过 `loading` 和 `hasMore` 防重复请求。
- 结果容器重建 pager 时清理旧监听器，避免旧查询继续触发请求。
- `state.error` 时暂停自动重试，只保留按钮触发重试，避免网络故障造成请求循环。
- 保留现有进度文字和 44px 以上按钮；最后一页仍由 `hasMore` 控制按钮消失。

## 风险与回退

- 极短结果列表可能在一次滚动前自动补齐多页；这是为了填满可视区域，仍受上游 `hasMore` 和去重保护限制。
- 网络失败只影响下一页，不影响已经显示的歌曲；回退方式是继续点击手动重试或关闭搜索面板。
- 生产 JS 改动需要更新 Service Worker 缓存版本，避免线上继续使用旧脚本。
