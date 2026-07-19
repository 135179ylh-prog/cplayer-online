# Verification - 部署与工程卫生加固

## 计划

- 检查 workflow YAML 与 staging 文件清单。
- 运行现有 Node、Python 和 Service Worker 静态检查。
- 检查 `git status --short`，确认本地生成物不再淹没工作区且任务文档仍可追踪。
- 推送后用真实浏览器打开 GitHub Pages，确认主站与独立下载页都可加载。

## 结果

- `npm test`：通过，4 个 Node 内置测试全部通过。
- `python scripts/check_module_syntax.py`：通过，242,053 字符的主模块通过 `node --check`。
- `node --check sw.js`：通过。
- `python -m py_compile scripts/check_module_syntax.py tests/verify_features.py`：通过。
- `python tests/verify_features.py`：通过；新增检查确认 Pages artifact 使用临时 staging 目录、包含全部白名单资源、不再上传根目录，并确认 `_headers` 已移除、README 与本地忽略规则已更新。
- `git diff --check`：通过；只有 Windows 的换行转换提示，没有空白错误。
- Windows 本机没有 Bash，无法逐字执行 GitHub Ubuntu runner 的 `cp` 段；静态验证已确认每个复制源存在，后续以 GitHub Actions 成功部署和真实浏览器加载作为最终工作流验证。
- 通过 `web-access` CDP 打开本地 `http://127.0.0.1:4173/`：页面标题为 `CPlayer 5`，左下构建徽标为 `v32`，设置页新版本提示存在，`window.mobileUI` 为对象且 Service Worker API 可用。
- 受保护 Claude Code review：`claude_peer.py review` 退出码 0，产物 `research/claude-review.md` 含 `<verdict>APPROVED</verdict>`；审阅者未发现阻塞问题。此前的短分析因轮数上限失败，保留为诊断，不作为审批依据。
- GitHub Actions：`Deploy GitHub Pages #41`（run `29700643654`，提交 `be1682d`）显示 `Success`，总时长 23 秒，artifact 为 24.8 MB。页面仅出现 GitHub 对 Node 20 action runtime 迁移到 Node 24 的平台警告，不是本项目失败。
- 线上 `https://135179ylh-prog.github.io/cplayer-online/`：主页面标题为 `CPlayer 5`，`v32` 徽标、设置页新版本提示、`mobileUI` 和 Service Worker API 均正常。相对路径请求 `_headers`、`.trellis/tasks/07-20-deployment-hygiene/prd.md`、`scripts/legacy/check_module_syntax.py` 均返回 404；`js/core-utils.js`、`manifest.json`、`sw.js` 均返回 200。
- 线上 `playlist-downloader.html` 标题为 `CPlayer 5 - 歌单下载器`，可见 1 个输入框和 1 个操作按钮，保留作为可直接访问的独立工具。

## 结论

部署白名单、无效配置清理、本地运行时忽略规则、API 依赖说明与版本文本澄清均已通过本地、独立审阅和线上部署验证。
