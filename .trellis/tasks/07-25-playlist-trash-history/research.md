# Research - 删除回收站与历史版本

## Confirmed Code Facts

- `js/app.js:353-355`：本机数据库为 `CPlayer5DB` v5，云同步待办使用 `cloud_outbox`。
- `js/app.js:433-481`：数据库升级采用追加式 `onupgradeneeded`，现有 `playlists`、`lyrics`、`images` 和 `cloud_outbox` 均可原位保留。
- `js/app.js:1415-1459`：歌单保存会在同一个 IndexedDB 事务中写本机记录和 owner-scoped outbox，适合扩展为同时保存历史快照。
- `js/app.js:1675` 附近：当前删除会移除本机歌单并写 delete outbox，因此本机没有可展示的回收站记录。
- `js/app.js:1786`、`js/app.js:1840` 附近：远端 tombstone 会被应用为本机删除，删除确认后也会清理本机记录。
- `js/app.js:4185-4317`：同步已具备单次收敛、owner 隔离、outbox 计数和冲突阻断，可扩展 restore/purge 操作，不需要第二套同步引擎。
- `js/cloud-sync.js:151-172`：远端规范化已保留 `deleted_at`；新增 `purged_at` 和历史快照应继续在这一边界统一校验。
- `js/cloud-sync.js:205-246`：当前同步决策能区分 tombstone、脏本机记录和冲突，但没有永久删除标记或恢复副本语义。
- `js/cloud-sync.js:325-353`：云服务当前直接列出歌单并调用 upsert/delete RPC；历史读取和 purge RPC 应保持同一封装边界。
- `supabase/migrations/202607230001_account_cloud_sync.sql:3-20`：云端歌单已有 `version`、`updated_at`、`deleted_at`，歌曲数组上限 10000。
- `supabase/migrations/202607230001_account_cloud_sync.sql:91-121`：新建时的 500 行限制目前包含 tombstone；更新使用版本号乐观锁。
- `supabase/migrations/202607230001_account_cloud_sync.sql:128-164`：删除只增加版本并写 `deleted_at`，名称和歌曲仍留在当前行。
- `index.html:2008-2057`：音乐资料库已有“我的歌单 / 最近播放”无障碍标签页，是回收站的自然入口。
- `index.html:2061-2085`：歌单详情已使用统一可访问弹窗，可在其工具栏增加历史入口，并复用叠层焦点管理。

## Applicable Specifications

- `.trellis/spec/frontend/quality-guidelines.md` 的 Core-Flow Storage、Browser Storage Resilience、Responsive Accessibility、Exact Pages Artifact、Optional Account And Cloud Playlist 合同全部适用。
- IndexedDB 升级必须追加、保留旧数据，并补 v5→v6、blocked、versionchange、quota 和桌面/手机真实存储往返测试。
- 弹窗、标签页和手机按钮必须维持 44px 触控目标、roving tabindex、hidden/inert 同步和 LIFO 焦点恢复。
- 所有云 payload 继续排除 ChKSz API 配置、队列、最近播放、播放进度和设备设置。
- 生产静态资源变化要更新 Service Worker 缓存版本，完整验证必须从最终 Pages 产物运行。

## Chosen MVP

- 回收站：本机和云端均保留 30 天，启动/同步时机会式清理，不依赖常驻服务。
- 历史：每个歌单最近 20 个、最长 90 天；采用完整歌单快照，以简单可审计优先。
- 永久删除：清空名称和歌曲内容，保留最小 purge marker；marker 不计入 500 个有效/回收站歌单上限。
- 冲突恢复：原 ID 已有较新内容时，保留该内容，并把待恢复版本改用新 ID 和“（已恢复）”名称。
- 历史跨设备：本机变更立即写快照；登录后通过现有 owner-scoped outbox 批量、幂等上传，另一设备按需拉取。

## Risks

- 完整快照比差量更占空间；通过 20 个 / 90 天双上限、5 MB 单歌单校验和可见错误控制风险。
- 旧版网页可能在新版数据库迁移后仍尝试恢复 purge marker；服务端必须拒绝对 `purged_at is not null` 的更新，避免旧客户端绕过永久删除。
- 30 天清理是“应用启动或同步时执行”，不是精确到秒的后台定时任务；界面按到期规则隐藏，下一次运行完成实际清理。
- 云迁移先于新版 Pages 才能避免新客户端调用缺失 RPC；回退只能前向修复，并保持 `DB_VERSION >= 6`。

## Full-Gate Finding

- 首次完整 `npm run verify` 在最终 Pages 产物的六视口 Axe 扫描中发现：空历史列表和预览会成为可滚动区域，但没有可聚焦子元素。
- 根因不是同步数据，而是新滚动容器缺少键盘入口；项目内歌词滚动区的正确模式是 `role="region"` + 可读名称 + `tabindex="0"`。
- 两个历史容器补齐同一模式后，原失败用例六视口 6/6 通过。最终完整门禁仍需重跑。

## Owner And Snapshot Identity Review

- 提交前跨层审查发现本机历史清理曾只按 `playlistId` 工作，极少数同 ID 外账号孤立历史可能被当前账号永久删除误清理。现已先按 `cloudOwnerId` 划定范围，当前账号只接管无 owner 的旧版快照。
- Supabase 服务端快照名 `server-<version>` 只在 owner + playlist 内唯一；直接作为 IndexedDB 全局 key 会让两个歌单的 `server-1` 相互覆盖。
- 本机现使用 owner + playlist + snapshot 的复合存储 ID，并单独保留原 `snapshotId` 作为上传身份。桌面/手机分别验证两个歌单同为 `server-1` 时均可保留。

## Rollback Preflight Finding

- DB v6 提交产生后，回退命令仍因官方 Supabase UMD bundle 内的定时器、认证跳转和可选遥测动态 import 失败；该 bundle 在 DB v5 线上提交中也完全相同，且不包含 IndexedDB/CPlayer5DB 调用。
- 分析器现只信任精确路径 `js/vendor/supabase.js` 与审计过的 SHA-256 组合。字节、路径或其他脚本不同即回到严格分析并失败关闭。
- 修复后新提交目标通过 current v6 / target v6；`origin/main` 明确因 target v5 被拒绝，证明门禁既可用又不会放行降级。

## GitHub Actions Timing Finding

- 首次生产发布 `Deploy GitHub Pages #54` 的唯一失败是既有动画生命周期测试：200ms 固定采样窗口要求请求和执行都大于 3，runner 实际各得到 3；其余 193 个浏览器测试通过。
- 本里程碑没有修改该测试。测试内部 `recurringCallbackDeltas` 已把请求和执行各 3 次视为可识别的循环，本机 `CI=1` 单 worker 连续 10 次也全部通过，证据指向共享 runner 负载造成的墙钟边界波动。
- 可见播放和可见恢复改用有上限的条件等待：最多 1 秒取得 4 次请求和执行；无循环仍会超时失败，重复循环、pending 上限以及暂停/隐藏 0 帧合同保持不变。
- 修复后在 `CI=1`、4 workers 的高负载模式下重复 20 次全部通过。
