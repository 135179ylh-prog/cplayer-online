# Design - 发布候选审计与交付

## 1. 证据层级

发布审计按可信度使用证据：

1. 当前完整命令输出：构建、单元、语法、静态契约、audit、浏览器、空白。
2. 当前源码与配置：Service Worker、Pages workflow、manifest、测试文件。
3. 已归档任务的验证记录：解释设计与历史问题，不替代当前门禁。
4. 实体设备记录：后台播放、锁屏和读屏等自动化无法证明的系统行为。

任何只有第 3 层、没有当前代码或设备证据的结论，必须标记为“历史证据”或“待设备确认”。

## 2. 核心链路矩阵

| 链路 | 当前自动化所有者 |
| --- | --- |
| 搜索 | `search-recovery.spec.mjs`、`api-config.spec.mjs` |
| 播放 | `playback-error.spec.mjs`、`responsive-accessibility.spec.mjs` 进度控制 |
| 队列 | `queue-roundtrip.spec.mjs` |
| 自建歌单 | `playlist-crud.spec.mjs`、备份用例 |
| 最近播放 | `recent-history.spec.mjs` |
| 备份恢复 | `backup-restore.spec.mjs` |
| 离线壳 | `app-shell.spec.mjs` |
| 更新升级 | `service-worker-update.spec.mjs` |

四视口响应式、弹窗、标签、触控和 Axe 由 `responsive-accessibility.spec.mjs` 横向覆盖。

## 3. 发布候选文档

- `release-notes.md`：面向使用者和维护者的变化、兼容性、限制、发布/回退。
- `device-validation.md`：实体设备操作步骤和结果表；默认状态均为未执行。
- `verification.md`：本任务实际命令、计数和 Goal 完成度审计。

这些文件随任务归档保留，不进入 Pages 站点。README 继续承担日常使用和本地验证说明。

## 4. 元数据修正

`manifest.json.description` 改成不承诺母带质量的产品描述。manifest 是预缓存生产资源，因此 `sw.js` 缓存提升为 `cplayer5-v57-release-candidate`。静态门禁同时拒绝 manifest 中重新出现“超清母带”。

## 5. 回退模型

- 代码：回退发布候选工作提交，或选择此前验证通过的提交。
- 缓存：回退后的 `sw.js` 使用其对应缓存名，更新生命周期会清理其他 `cplayer5-*` 缓存。
- 数据：本阶段不迁移 IndexedDB/localStorage，不应清站点数据。
- 验证：回退后重新跑 `npm run verify`，再部署；线上确认构建标记、设置、队列和更新提示。
