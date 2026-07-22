# Verification - 发布候选审计与交付

## 结论

2026-07-22 完成本地发布候选：产品元数据真实、缓存 v57、完整自动门禁和四视口回归通过，发布说明、回退方案与实体设备清单已齐。没有 push、部署、tag 或远端 workflow 操作。

长期 Goal 的本地自动化与交付资产已经完成；真实华为设备后台/锁屏/TalkBack 和远端 Pages 部署仍未执行，因此不能宣称这些外部环节已经通过。

## Goal 五项完成度

| Goal 标准 | 当前证据 | 结论 |
| --- | --- | --- |
| 1. 八条核心链路端到端质量基线 | 当前 82 个 Playwright 用例；下方链路矩阵；10 个单元测试 | 本地自动化完成 |
| 2. 弱网、API、刷新、后台限制、缓存升级、异常恢复 | timeout/retry/auth、搜索恢复、队列/播放会话、旧 Worker 离线升级、原子备份；实体后台清单 | 代码与自动化完成；实体后台待执行 |
| 3. 手机、折叠屏、桌面、无障碍、性能 | `1280x800`、`390x844`、`355x800`、`440x707`；Axe；模块拆分与资源基线 | 浏览器层完成；TalkBack 实机待执行 |
| 4. 可重复构建、测试、回归、发布检查与 Trellis 规范 | `npm run verify` 8 层；Pages quality → deploy；frontend contracts | 完成 |
| 5. 问题关闭、稳定候选、发布说明与回退 | 本文件、`release-notes.md`、`device-validation.md`；工作提交/归档流程 | 本地候选完成；远端发布待用户确认 |

## 八条核心链路

| 链路 | 当前浏览器证据 | 结果 |
| --- | --- | --- |
| 搜索 | `search-recovery.spec.mjs`、`api-config.spec.mjs` | 桌面/手机通过 |
| 播放 | `playback-error.spec.mjs`、进度键盘真实音频边界 | 桌面/手机通过 |
| 队列 | `queue-roundtrip.spec.mjs` IndexedDB 写入/刷新/清空 | 桌面/手机通过 |
| 自建歌单 | `playlist-crud.spec.mjs` 新建/删除/取消/空名 | 桌面/手机通过 |
| 最近播放 | 50 条上限、非法条目过滤、清空 | 桌面/手机通过 |
| 备份恢复 | 有效导入、格式错误原子回退、损坏 JSON | 桌面/手机通过 |
| 离线壳 | active Worker 在线缓存后离线重载 | 桌面通过；移动重复用例按设计跳过 |
| 更新升级 | 旧 Worker → v57、缓存/数据保留、离线刷新、稍后刷新 | 桌面/手机通过 |

## 最终命令证据

第一次使用 `PW_PORT=4174` 运行时，前 6 层通过，但浏览器服务器启动前发现该端口被无关的“云顶之弈” Vite 服务占用；未结束该进程，也未把端口冲突记为产品失败。

改用空闲 `PW_PORT=4175` 后，`npm run verify` 在 160.1 秒内通过全部 8 层：

1. Tailwind CSS 生成通过；
2. 10/10 单元测试通过；
3. `js/app.js` 直接语法检查通过，`RECENT_HISTORY_KEY` 1 处；
4. Service Worker 语法通过；
5. 静态功能契约通过，构建标记 `v32`，核心资源 11 个；
6. npm audit 报告 0 个漏洞；
7. Playwright 82 个用例中 80 通过、2 个预期跳过、0 失败；
8. Git 空白检查通过，只有 LF/CRLF 转换提醒。

两个跳过项均为既有范围设计：桌面项目跳过仅移动端存在的封面/歌词切换，手机项目跳过重复的离线壳 Service Worker 契约。

## 发布候选变化

- `manifest.json.description` 改为“支持歌单、播放恢复和 PWA 安装的在线音乐播放器”，不再保证母带音质。
- Service Worker 提升到 `cplayer5-v57-release-candidate`；manifest 继续包含在 11 个核心资源中。
- 静态门禁禁止 manifest 重新出现“超清母带”。
- 发布说明和实体设备清单位于本任务目录，归档后仍可追溯。

## 未执行的外部验证

- 华为 Pura X 真实后台 60 秒、锁屏 60 秒、系统媒体通知、蓝牙按键与省电模式。
- TalkBack 实际播报顺序和折叠状态切换。
- push 后 GitHub Actions 运行、Pages 部署和线上旧版本升级。
- WebKit/Firefox 自动回归；当前项目门禁和 CI 明确为 Chromium。

这些项目没有被标成通过。执行步骤和记录格式见 `device-validation.md`；远端操作必须等待用户确认。
