# PRD - 部署与工程卫生加固

## 背景

最新审查指出 GitHub Pages 目前可能将整个仓库作为部署产物上传，连同 Trellis 任务记录、截图和历史维护脚本一起公开。审查还指出 `_headers` 采用非 GitHub Pages 格式、开发工具生成物持续污染工作区，以及第三方在线 API 的可用性边界没有在用户文档中说明。

## 目标

- GitHub Pages 只部署运行网站所需的静态文件，不部署内部任务资料、测试或维护脚本。
- 移除或迁移不对 GitHub Pages 生效的站点根目录配置，避免产生虚假的安全/缓存预期。
- 精确忽略本地 agent、Trellis 运行时和测试生成物，同时继续追踪正式的任务文档与工作流文件。
- 在 README 说明在线搜索、歌词和取流依赖第三方 API 的边界。

## 接受标准

1. Pages 工作流明确构建一个仅含站点文件的 staging 目录，并将该目录作为 artifact 上传。
2. staging 文件清单覆盖当前网站入口、静态脚本、样式、字体、图片、manifest 和 Service Worker，不包含 `.trellis/`、测试、`scripts/` 或 `.github/`。
3. `_headers` 不再作为 GitHub Pages 生效配置留在部署根目录。
4. `.gitignore` 解决当前本地脚手架噪音，但不忽略 `.trellis/tasks/` 的任务文档、`.trellis/workflow.md` 或 `get_context.py`。
5. README 清楚说明第三方 API 不可用时的用户可见影响与本地仍可用的内容。
6. 工作流 YAML、静态文件清单和现有自动化检查均通过；推送后线上页面可正常加载。

## 暂缓项

- 一次性拆分播放器单文件、迁移到 Vite 或 TypeScript。
- 在没有经过验证的服务提供方前添加 API fallback。
- 删除可能存在直接访问用户的 `playlist-downloader.html`。
- 统一产品版本号和 Service Worker 缓存版本号；两者服务不同用途。
