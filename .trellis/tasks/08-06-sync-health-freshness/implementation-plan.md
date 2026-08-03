# 实施计划：同步健康检查的新鲜待办状态

1. [x] 增加桌面/手机回归，先复现内存待办数量落后于 IndexedDB 的问题。
2. [x] 让云同步健康项接受 IndexedDB 快照数量，并修正待办状态分级。
3. [x] 更新静态 feature contract、Service Worker 缓存版本和任务文档。
4. [x] 运行定向桌面/手机测试与完整 `npm run verify`。
5. [x] 独立提交、推送，等待 Pages 部署后完成线上健康检查验收。
