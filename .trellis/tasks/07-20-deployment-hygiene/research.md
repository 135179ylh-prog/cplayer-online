# Research - 部署与工程卫生审查核对

## 已核实

- `.github/workflows/pages.yml` 原先把 `path: .` 交给 `actions/upload-pages-artifact@v3`。该 action 不读取 `.gitignore`，只排除 `.git` 和 `.github`；已追踪的 `.trellis/tasks/`、`scripts/`、测试和文档都会进入公开 artifact。这不是密钥泄露，但会把非站点交付物发布为静态文件。
- 根 `_headers` 没有项目引用，GitHub Pages 也不解释 Cloudflare/Netlify 的该格式。线上检查显示 `/_headers` 被当成普通 `application/octet-stream` 文件提供，`sw.js` 仍是 GitHub Pages 默认的 `Cache-Control: max-age=600`，证明文件中的 `no-cache` 从未生效。
- 原工作区有 169 个未跟踪文件，主要来自 `.agents/`、`.claude/`、`.codex/` 和 Trellis bootstrap/runtime。`.agents/skills/trellis-start/SKILL.md`、`.trellis/workflow.md`、`.trellis/scripts/get_context.py` 与任务文档已经追踪，忽略规则必须把它们排除在外。
- `index.html` 为 337,193 bytes、7,045 行，主模块约 5,228 行，维护成本是真实问题；但它使用 `type="module"`，所以“所有变量都在全局作用域”不成立。全量拆分将大幅扩大播放、离线和移动端回归面，不在本轮实施。
- `js/tailwindcss.js` 是 407,362-byte Tailwind Play CDN 运行时包，主页面同步加载，下载工具还直接加载远程 Play CDN。运行时编译确实不适合生产 PWA；静态 CSS 迁移需要生成配置、更新两个页面和 Service Worker 缓存，作为下一独立任务实施。
- 主播放器的 API 地址集中在 `index.html` meta；独立 `playlist-downloader.html` 仍有同域硬编码。它没有站内引用，但可能被直接收藏，暂不删除。没有已验证的备用服务，不能凭空添加 fallback。
- UI 的旧 `v5.2.1 / 2026.03.20` 文本、左下 `v32` 构建徽标和 Service Worker 缓存版本用途不同。移除过期 UI 文本并在 README 解释语义，比强行统一版本号更安全。

## Claude peer

只读 Claude peer 可以启动并读取任务文件，但在 `max turns=3` 限制内没有生成最终分析，退出码为 1。诊断保存在 `research/claude-analysis.md`，不作为审阅通过或实现依据。

## 决策原则

只修改有代码或平台行为证据、低回归风险的事项。保持用户已有页面路径、播放与离线功能不变；无证据的删除和未验证的备用 API 不纳入本轮。
