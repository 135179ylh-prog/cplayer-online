# 研究记录：恢复包导入预览

## 现有实现

- `parseRecoveryPackage` 已负责完整格式和歌曲字段校验。
- `importRecoveryPackageFile` 已负责生成新 ID、历史映射和单事务写入。
- 资料库使用统一的 `openAccessibleOverlay`，并通过 `isOverlayInteractionTarget` 防止弹窗外点击误关闭播放器面板。
- 恢复包导入入口位于 `bindUserPlaylistUI` 的文件 input change 事件。

## 决策

把“解析/生成计划”和“提交计划”拆开，而不是在 UI 层复制恢复规则。普通导入入口继续调用 `importRecoveryPackageFile`，因此现有内部调用和测试契约保持兼容；UI 先调用只读计划函数，确认时再提交。

## 风险与缓解

- 预览后数据可能变化：确认时重新读取并生成计划。
- 手机弹窗空间较小：使用统一 94vw、最大高度和可滚动内容，按钮保持 44px 触控尺寸。
- Service Worker 可能继续提供旧 `app.js`：更新缓存版本并验证 Pages 产物。
