# 设计：恢复包导入预览

## 数据流

```text
文件选择 → 文件/JSON 校验 → 只读读取现有歌单 → 内存导入计划 → 预览弹窗
                                                        ↓ 确认
                                           重新读取现有歌单 → 单 readwrite 事务
```

## 内存计划

`createRecoveryImportPlan(parsed)` 负责读取当前歌单、生成新 ID、去重名称、建立历史 `playlistId` 映射，并返回：

- `records`：准备写入的 active/trash 歌单
- `history`：准备写入的历史版本
- `summary.activeCount`、`summary.trashCount`、`summary.historyCount`
- `summary.conflictCount`：原始名称与现有或同包名称冲突的数量

计划生成只读 IndexedDB；真正的 `put` 仍由现有原子事务负责。

## UI

新增 `#recoveryImportPreviewModal`，使用现有 `openAccessibleOverlay` 焦点栈：

- `#recoveryImportPreviewSummary`：数量摘要
- `#recoveryImportPreviewStatus`：加载/错误状态
- `#recoveryImportPreviewCancelBtn`：取消并清空待确认状态
- `#recoveryImportPreviewConfirmBtn`：重新生成计划并提交

遮罩点击、Escape 与取消按钮都走同一个关闭函数。确认成功后刷新资料库和回收站，再显示导入结果 toast。

## 不变量

- 预览和取消不访问写事务。
- 确认前不创建 `cloud_outbox`。
- 确认重新读取现有名称，避免预览期间另一处新增歌单造成覆盖或重名。
- 失败不关闭预览，用户可以取消或重试。
