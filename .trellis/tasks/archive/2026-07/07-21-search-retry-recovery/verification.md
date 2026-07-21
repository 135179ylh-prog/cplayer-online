# Verification - 搜索失败重试与恢复

## 计划

- `npm run build:css`
- `npm test`
- `python scripts/check_module_syntax.py`
- `node --check sw.js`
- `python tests/verify_features.py`
- `git diff --check`
- Playwright：桌面和移动分别模拟首次搜索失败、点击重试、第二次成功，并核对查询词、面板状态、文案与控制台。

## 结果

### 自动化检查（2026-07-21）

- `npm run build:css`：通过；新增重试控件所需 CSS 已重新生成。
- `npm test`：通过；9 个单元测试全部成功。
- `python scripts/check_module_syntax.py`：通过。
- `node --check sw.js`：通过。
- `python tests/verify_features.py`：通过；确认共享重试状态接入桌面和移动入口，Service Worker 缓存为 `v51-search-retry`。
- `git diff --check`：通过；仅有 Git 的 LF/CRLF 提示。

### 真实浏览器回归（Chrome / Playwright）

- 桌面 `1280 × 800`：模拟搜索接口前两次请求失败，页面保留查询词并显示 `role="status"`、服务失败文案和 `重试搜索：重试测试` 按钮；点击后第三次请求成功，结果正常显示。
- 移动 `390 × 844`：模拟搜索失败后显示紧凑重试状态，底部面板与查询词保持；点击重试后结果正常显示。
- 离线桌面：浏览器切换为 offline 后搜索显示“当前已离线”，查询词与重试按钮保留。
- 重试使用原查询词，不清空输入，也不关闭当前搜索面板。
- 最后使用新浏览器会话确认页面启动无错误；模拟请求产生的控制台错误仅来自预期的失败日志。

### 外部依赖

- 浏览器回归使用本地确定性路由模拟第三方 API 的失败与成功，未把第三方在线率当成本地功能条件。
