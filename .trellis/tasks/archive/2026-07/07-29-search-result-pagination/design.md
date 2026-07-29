# Design - 搜索结果完整分页

## 根因

`MusicService.search()` 把 `/163_search` 的 `limit` 固定为 30，桌面渲染又执行一次 `slice(0, 30)`。线上接口实际返回 `data.total`，并支持 `offset`，所以缺失发生在客户端请求和渲染边界。

## 数据流

```text
搜索词 + offset
  → ChKSzAPI.buildUrl（limit=30，offset=N）
  → MusicService 规范化 songs/total/hasMore/nextOffset
  → 桌面或手机当前查询状态
  → 追加去重后的歌曲行与共享分页状态栏
```

## 合同

- `normalizeSearchPage(payload, { offset, limit })` 是 API 负载的唯一解析边界，兼容 `data[]`、`data.songs[]` 和 `result.songs[]`。
- `mergeUniqueSearchSongs(existing, incoming)` 以字符串化歌曲 ID 去重；缺少 ID 的非法项不进入结果。
- 分页游标使用上游实际消耗的 `nextOffset`，不能用去重后的显示数量代替。
- `desktopSearchRequestId` / `MobileUI.searchRequestId` 同时保护首屏和后续页；按钮回调必须核对查询身份。
- 共享分页状态栏负责进度、44px 加载按钮、加载中、失败重试和无更多结果反馈，桌面/手机不各写一套判断规则。

## 失败与恢复

- 首屏失败沿用现有搜索恢复状态。
- 后续页失败保留已有歌曲，状态栏显示失败并恢复“重试加载”按钮。
- 返回重复页且没有新增歌曲时停止继续加载，避免无限请求。
- 接口不提供总数时，以“本页不足 30 首”作为结束条件。

## 发布影响

- 修改 `js/app.js` 与 `js/core-utils.js` 后递增 Service Worker 缓存名。
- 更新确定性的 Node 与 Playwright 测试；CI 不访问真实 ChKSz。
- API 密钥、API 地址、播放队列、最近播放和进度仍只存本机。
