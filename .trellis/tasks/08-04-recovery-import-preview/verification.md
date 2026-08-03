# 验证：恢复包导入预览

## 验证记录

- 定向恢复包测试：桌面/手机共 10 通过、0 失败。
- `node --check js/app.js`：通过。
- `python tests/verify_features.py`：通过。
- `npm run verify`：45/45 单元测试通过；Pages 产物浏览器回归 220 通过、12 跳过、0 失败；仓库检查通过。
- Pages 工作流：#30779167692，`success`，部署提交 `568acad`。
- 线上桌面浏览器：`https://135179ylh-prog.github.io/cplayer-online/` 显示 `v33`、`cplayerReady=true`；恢复包预览弹窗可见，活动/回收站/历史数量为 `1/0/0`，取消后弹窗关闭且 ready 状态保持。
- 手机视口：同一 Pages 产物由完整 `mobile-chromium` 回归覆盖；定向恢复包测试桌面/手机 10/10 通过。

## 覆盖矩阵

| 场景 | 预期 |
| --- | --- |
| 有效包选择后 | 只显示预览，数据库不变 |
| 取消/Escape/遮罩 | 关闭预览，数据库不变 |
| 确认 | 新 ID、trash、history 映射写入，outbox 不新增 |
| 重名 | 预览显示数量，结果使用恢复命名 |
| 损坏包 | 原错误 toast，不打开预览，不写库 |

## 已覆盖证据

- 有效包选择后预览显示 1 个活动歌单、1 个回收站歌单和 1 个历史版本，IndexedDB 快照保持不变。
- Escape 关闭预览后 IndexedDB 快照保持不变。
- 确认后生成新 ID、保留 trash、映射 history，`cloud_outbox` 仍为 0。
- 现有名称冲突显示数量 1，确认后名称为“恢复目标（已恢复）”。
- 损坏 JSON/错误格式不打开预览并保留原错误提示。
