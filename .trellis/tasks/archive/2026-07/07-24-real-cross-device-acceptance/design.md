# Design - 真实跨设备验收

## Evidence Model

真实验收与自动化证据互补：

```text
自动化（确定性 HTTP mock + 独立浏览器）
  -> 证明算法、存储和边界在桌面/手机回归中可重复

真实设备 A + 正式 Supabase + 真实设备 B
  -> 证明账号、RLS、网络、浏览器持久化和 Pages 部署在实际环境串起来
```

真实验收只通过产品 UI 和公开浏览器状态观察，不直接改表、不读取 auth token。
证据允许记录：设备类别、浏览器、时间、测试歌单 id/name、歌曲 id 顺序、
`data-cplayer-cloud-*`、状态中心文本和截图。禁止记录：密码、access/refresh
token、API 密钥/API 地址、完整 localStorage 转储。

## Test Data

- 名称格式：`跨设备验收-20260724-<4位随机>`。
- 只从设备 A 当前播放队列选择 3 首已有歌曲，避免依赖实时搜索服务。
- 验收前记录 A/B 可见非测试歌单名称与数量的摘要；清理后只比较摘要，不
  导出或上传用户歌单内容。
- 删除测试歌单会留下当前设计的云 tombstone。它是下一里程碑回收站/历史
  的真实输入，不在本阶段用 SQL 硬删。

## Timeline

1. Baseline：两端登录同一账号，手动同步，记录 0 pending / 0 conflicts。
2. A→B：A 新建测试歌单、加入 3 首并调整为已知顺序，等待 synced；B 同步并
   比较 id/name/song ids/order。
3. B→A：B 交换两首顺序并同步；A 同步后比较。
4. Offline：B 断网再改顺序，记录本地 UI 和 pending；联网后等待归零，A 拉取。
5. Conflict：B 再次断网并基于当前版本修改；A 在线做不同修改并先同步；B
   联网后记录 conflict。未选择前分别记录 B local 与 A cloud-visible 版本。
6. Resolution：在 B 明确选“使用本机”，等待 synced；A 拉取并比较最终顺序。
7. Delete：A 删除测试歌单并同步；B 拉取删除，比较非测试歌单摘要无变化。

## Stop And Recovery Rules

- 任一步出现 `error`、owner collision、待同步长期不归零或数据不一致，立即
  停止后续写操作；保留测试歌单和 outbox，不退出账号、不清网站数据。
- 先记录两端状态与最后成功时间，再判断是网络、会话、冲突或产品缺陷。
- 不以反复点击同步、直接删表或重新注册账号掩盖问题。
- 用户随时可以停止手机操作；设备 A 不执行破坏性清理。

## Automated Release Gate

即使本阶段无产品代码改动，也重新运行桌面/手机账号同步用例和完整
`npm run verify`，证明验收记录/任务收尾没有伴随仓库漂移。独立文档提交
推送后监控 Pages，并只读确认线上仍为 v64 状态中心。
