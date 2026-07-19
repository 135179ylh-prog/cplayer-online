# PRD - Tailwind 静态化构建

## 背景

主播放器当前同步加载 407 KB 的 Tailwind Play CDN 运行时包，下载器还从公网加载 Play CDN。两者都会在用户设备上扫描 HTML 并即时生成样式，不适合手机 PWA 的首屏、内存和离线体验。

## 目标

- 用固定版本的 Tailwind CLI 在开发/提交时生成静态 CSS。
- 主播放器和独立下载器都改用同一份本地样式，不再加载 Tailwind Play CDN。
- 生成后的 CSS 随 GitHub Pages artifact 部署，并由 Service Worker 预缓存。
- 保持现有页面布局、深色风格、图标和播放器功能不变。

## 接受标准

1. 两个 HTML 页面不再引用 `js/tailwindcss.js` 或 `https://cdn.tailwindcss.com`。
2. `package.json` 有可重复的构建脚本，Tailwind 版本固定；生成的 `css/tailwind.css` 被提交。
3. Tailwind 内容扫描覆盖两个 HTML，当前所有 utility class 都能生成。
4. `sw.js` 预缓存新 CSS、移除旧运行时 JS 并升级 cache name，离线刷新不会混用旧资源。
5. 主页面和下载器在桌面/移动视口可加载，核心交互与视觉层级没有明显回归。
6. 自动化检查、静态 CSS 构建和线上 Pages 部署均通过。

## 非目标

- 引入 Vite、PostCSS pipeline、完整模块打包或 TypeScript。
- 重写现有内联业务逻辑和自定义 CSS。
- 更改 API、歌单、播放队列或下载器的业务行为。
