# Verification - Tailwind 静态化构建

## 计划

- `npm run build:css`
- `npm test`
- `python scripts/check_module_syntax.py`
- `node --check sw.js`
- `python tests/verify_features.py`
- `git diff --check`
- 通过 CDP 在桌面与移动视口加载主页面和下载器，检查主布局、控制栏、可见文字和静态 CSS。
- 推送后确认 GitHub Pages workflow 成功，线上两个页面不再请求 Tailwind runtime。

## 结果

- `npm install --save-dev tailwindcss@3.4.17`：完成，75 个审计依赖中 0 个已知漏洞；随后以 `--package-lock-only` 同步精确版本。
- `npm run build:css`：通过，生成 27,815-byte `css/tailwind.css`。Tailwind 只提示 Browserslist 数据库可更新，不影响构建结果。
- `npm test`：通过，4 个 Node 内置测试全部通过。
- `python scripts/check_module_syntax.py`、`node --check sw.js`、`python -m py_compile scripts/check_module_syntax.py tests/verify_features.py`、`python tests/verify_features.py`：全部通过。
- runtime 引用扫描：`index.html`、`playlist-downloader.html`、`sw.js` 中没有 `tailwindcss.js`、`cdn.tailwindcss.com` 或 Tailwind runtime script。
- `git diff --check`：通过；只有 Windows 换行转换提示，没有空白错误。
- CDP 桌面截图：主播放器和下载器均保持正常可见布局；关键计算样式与迁移前一致。
- CDP 390 x 844 iframe：移动布局显示、桌面布局隐藏，移动控制仍完整；新 Service Worker cache 包含静态 CSS。
- 受保护 Claude Code review：第一次因 `max turns=10` 未产生 verdict，保留 `research/claude-review.md` 作为诊断；第二次以 `max turns=20` 完成，`research/claude-review-02.md` 含 `<verdict>APPROVED</verdict>`，没有阻塞发现。

## 待完成

- 推送后验证 GitHub Pages 上的两个页面和缓存资源。
