# Verification - 审计加固

## 计划

- `node --test tests/*.test.mjs`
- `node --check _check.js`
- `node --check sw.js`
- `python -m py_compile verify_features.py`
- `python verify_features.py`
- `python check_recent.py`
- `git diff --check`
- 通过 web-access/CDP 在桌面和移动视口检查加载、搜索、加入歌单、断网提示和恢复提示。

## 结果

- `npm test`：通过，4 个 Node 内置测试全部通过。
- `python scripts/check_module_syntax.py`：通过，实际抽取 242KB inline module 并通过 `node --check`。
- `node --check sw.js`：通过。
- `python -m py_compile scripts/check_module_syntax.py tests/verify_features.py`：通过。
- `python tests/verify_features.py`：通过，包含 v32、API 重试接线、core-utils 预缓存、图片尺寸和根目录清理检查。
- `git diff --check`：通过；Git 仅提示 Windows 工作树的换行转换警告，没有空白错误。
- `web-access` CDP 依赖检查：Node、Chrome 9222 和 proxy 均 ready。
- 本地 `http://127.0.0.1:4173/`：页面标题为 `CPlayer 5`，正文显示 v32 和播放列表空态；`window.mobileUI` 已初始化；桌面/移动封面为 `decoding=async`，canvas 的 `aria-hidden=true`。
- Claude peer：readiness 通过，但审阅未在窗口内返回 `<analysis_done>`，因此没有 Claude approval 结论。

## 剩余风险

- 尚未在真实 API 成功响应下播放音频；本轮主要改动网络错误处理和静态页面，不改变播放队列协议。
- 未跟踪的个人调试脚本仍可能在开发者工作树中存在，但已被忽略且不会随提交发布。
