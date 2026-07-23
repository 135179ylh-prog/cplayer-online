# Research - 同步状态中心

## Existing Owners

- `js/app.js` 的 `cloudState`、`cloudStateMessage` 和 `setCloudState` 是唯一状态
  owner；根元素目前只暴露 `data-cplayer-cloud-state`。
- `cloud_outbox` 已在 CPlayer5DB v5 中按 owner 存储真实待同步操作；本地歌单
  与 outbox 在一个事务写入，不需要新增 schema。
- `cloudConflicts` Map 保存冲突，但原同步轮次不会清理已消失的旧项；账号卡
  只显示第一项且没有总数。
- 账号卡已有唯一 live region 和显式本机/云端选择；桌面/手机主界面没有同步
  状态入口，用户必须打开设置才能发现错误。
- 同步是 single-flight，发生在 app ready 之后；本阶段必须保持该顺序。

## Observed Gaps

- 当前只有一条自由文本，无法回答“还有几项”“上次何时成功”“有几个冲突”。
- 离线 pending 与错误不会显示在设置齿轮，用户容易误以为已完成。
- 手动同步在 `remaining.length > 0` 时仍可能 toast“歌单同步完成”。
- 退出后 owner outbox 仍保留，但当前 signed-out UI 不提示存在待同步修改。
- 当前 22 个账号浏览器用例覆盖数据安全，但没有状态中心计数、最近成功、错误
  重试或入口摘要的断言。

## Reuse Decision

复用 `setCloudState`、`readCloudOutbox`、`cloudConflicts`、现有同步按钮和唯一
live region。只新增一个纯投影函数与一个本机最近成功记录，不增加 modal、
路由、数据库 store 或第二套同步 dispatcher。

## Review Findings

- 提交前审查发现 outbox 异步读取可能晚于同步完成结果；增加最新读取令牌，
  旧读取不能覆盖新计数。
- 首轮完整门禁发现字体产物用例重复写死旧 `v63` 前缀。测试已改为验证通用
  CPlayer 缓存名格式，当前精确 `v64-sync-status` 继续由静态契约唯一拥有。
- 次轮完整门禁确认全部浏览器用例通过，但根级旧 Trellis 文档的 UTF-8 BOM
  被严格仓库检查拒绝；移除 4 个隐藏 BOM 后最终整套门禁通过。
