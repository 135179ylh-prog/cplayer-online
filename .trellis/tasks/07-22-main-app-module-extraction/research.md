# Research - 主应用模块拆分与性能基线

## 2026-07-22 基线

### 文件与装载

- `index.html`：388269 字节；PowerShell 解码后 380001 个字符。
- 主 `<script type="module">` 位于原文件第 1823-7851 行，语法检查报告模块文本 281491 字符。
- 模块之前依次加载 `js/color-thief.umd.js` 和 `playlist.js`；不能调换。
- 主模块只有 `from './js/core-utils.js'` 一个静态 import，没有 `import.meta`、动态 import 或 `document.currentScript`。
- 模块标签后仍有 build badge、音乐资料库和歌单详情 DOM；ES module 的延迟执行语义保证这些节点先完成解析。

### 发布与缓存

- `.github/workflows/pages.yml` 复制整个 `js/` 目录，`js/app.js` 不需要新增独立发布命令。
- `sw.js` v55 预缓存 10 个核心资源，包括 `index.html` 与 `js/core-utils.js`。
- 本地脚本走缓存优先；若只外置 HTML 而不提升缓存并加入脚本，离线安装会缺少主模块。

### 质量保护

- `scripts/check_module_syntax.py` 当前从 HTML 正则提取最大内联脚本，再写临时 `.mjs` 检查；外置后应直接检查生产文件。
- `tests/verify_features.py` 目前把 DOM 和业务断言都放在 `required_html`，迁移时必须按真实文件拆分。
- 完整 Playwright 基线为 80 个用例：78 通过、2 个预期跳过。现有离线壳与旧 Worker 升级测试可证明外置模块离线执行。

## 设计结论

- 当前回归覆盖已达到早期路线中“大文件迁移前先建立浏览器证据”的前置条件。
- 先建立单一外部模块边界，不在同一任务继续拆业务模块，可把行为变化控制在 import、入口、缓存和检查四个可验证边界。
- 资源拆分的首要收益是维护和缓存粒度；总字节数基本不变，所以验证记录必须避免夸大首次加载性能。
