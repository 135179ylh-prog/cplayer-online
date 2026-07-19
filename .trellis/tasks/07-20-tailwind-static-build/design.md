# Design - Tailwind 静态化构建

## 构建输入和输出

- 固定 `tailwindcss@3.4.17`，与现有 Play CDN bundle 的版本一致，降低 utility 行为差异。
- `tailwind.config.cjs` 扫描 `index.html` 和 `playlist-downloader.html`。
- `css/tailwind.input.css` 仅包含 Tailwind 的 base、components 和 utilities 指令。
- npm `build:css` 生成压缩的 `css/tailwind.css`。该产物提交到仓库，因为 Pages workflow 只复制静态文件而不运行构建。

## 页面接入

两个页面用 `<link rel="stylesheet" href="css/tailwind.css">` 取代运行时脚本。样式链接放在各页面已有内联 `<style>` 之后，保证 utility class 的优先级接近现有运行时生成样式，随后以实际浏览器渲染核对。

## 离线缓存

Service Worker 的 core asset 清单将旧 `./js/tailwindcss.js` 替换为 `./css/tailwind.css`，并更新 cache name。激活时仍清理旧 `cplayer5-*` 缓存，确保客户端不会混合静态 CSS 和旧运行时脚本。

## 验证策略

构建后扫描两个页面，确认没有 Play CDN 引用；扩展现有静态验证以断言 CSS、配置、构建脚本和 Service Worker cache 条目。通过 CDP 比较桌面和移动页面的关键结构、尺寸和计算样式，并验证线上 artifact。
