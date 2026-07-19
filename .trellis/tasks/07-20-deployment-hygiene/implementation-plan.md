# Implementation Plan - 部署与工程卫生加固

- [x] 核实审查结论、读取现有任务和开发规范。
- [x] 核实 Pages artifact、`_headers`、忽略规则及现有资源的准确清单。
- [x] 修改 Pages workflow，建立最小 staging artifact。
- [x] 更新 `.gitignore`，移除无效 `_headers`，补充 README 的 API 依赖说明。
- [x] 用 YAML/文件清单、现有测试和本地浏览器加载检查验证。
- [x] 完成独立只读审阅并更新验证记录。
- [x] 提交并推送；确认 GitHub Pages 部署和线上页面。

## 后续候选

- 将运行时 Tailwind 编译迁移为构建期静态 CSS。
- 按模块逐步从 `index.html` 抽出请求层、播放器状态和 UI 渲染逻辑。
