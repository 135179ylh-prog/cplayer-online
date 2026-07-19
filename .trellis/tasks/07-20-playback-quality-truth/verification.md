# Verification - 播放音质如实标识

## 计划

- `npm test`：覆盖 API 标注、码率回退、未知状态和 320 kbps 分类。
- `python scripts/check_module_syntax.py`、`node --check sw.js`、`python tests/verify_features.py`。
- 本地浏览器检查初始状态、桌面徽标、移动端同步和可访问性属性。
- 推送后确认 GitHub Pages 页面加载与新脚本资源。

## 结果

- `npm test`：通过，5 个 Node 内置测试全部通过；新增覆盖 API 明确标注、320 kbps、FLAC 推断、无单位低数值和未知状态。
- `python scripts/check_module_syntax.py`、`node --check sw.js`、`python -m py_compile scripts/check_module_syntax.py tests/verify_features.py`、`python tests/verify_features.py`：全部通过。
- 静态扫描确认旧的 `getQualityBadge`、`d.level || level`、加载时硬编码 JyMaster 和基于 `320` URL 的 Hi-Res 逻辑均已移除。
- `git diff --check`：通过；只有 Windows 换行转换提示，没有空白错误。
- 本地 CDP：桌面两个质量节点均显示“音质待确认”，具备 `quality-unknown`、相同 title/aria-live/aria-label；页面中不再出现“超清母带”保证文案。
- 390 x 844 iframe：移动布局显示、桌面布局隐藏，移动质量节点仍为“音质待确认”且说明一致。
- 本地 Service Worker 更新为 `cplayer5-v49-quality-truth`。
- 使用没有旧 Service Worker 的本地端口动态导入 `core-utils.js`：API `jymaster` 返回“标注 JyMaster”；320000 bps 返回“高音质”；无单位 `320` 返回“音质未标注”；`.flac` pathname 返回“无损”。
- 受保护 Claude Code review：第一轮 `research/claude-review.md` 和最终轮 `research/claude-review-02.md` 都含 `<verdict>APPROVED</verdict>`；最终审阅确认请求等级不会伪装成 API 元数据、双端徽标使用同一渲染入口、未知码率保守处理符合设计。
- 已提交并推送 `1e8f991`（`fix: make playback quality labels truthful`）。GitHub Actions 的 `Deploy GitHub Pages #46` 已成功完成。
- 线上页面 `https://135179ylh-prog.github.io/cplayer-online/`：桌面与移动质量节点均为“音质待确认”，使用 `quality-unknown`，并具有相同的 title 与 `aria-label`。浏览器缓存仅保留 `cplayer5-v49-quality-truth`。
- 线上 390 x 844 窄屏 iframe：桌面质量节点无布局尺寸，移动质量节点可见，文字、title 与 `aria-label` 正确。
- 已将外部音质元数据、保守推断和双端同步的约定记录到 `.trellis/spec/frontend/quality-guidelines.md`，供后续改动复用。

## 待完成

- 无。
