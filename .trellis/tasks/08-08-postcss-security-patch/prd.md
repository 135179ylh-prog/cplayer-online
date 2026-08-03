# PRD：PostCSS 安全公告修复

## 目标

消除质量门禁发现的 PostCSS moderate 安全公告，同时保持 Tailwind CSS 构建和线上播放器行为不变。

## 范围

- 将构建链使用的 PostCSS 固定到公告修复版本 `8.5.23`。
- 更新锁文件，确保本机和 CI 使用同一修复版本。
- 重新运行桌面/手机浏览器回归与完整 `npm run verify`。

## 非目标

- 不改变播放器运行时 JavaScript、Service Worker、云同步或用户数据。
- 不把 PostCSS 打包进 GitHub Pages 线上产物。

## 验收标准

1. `npm ls postcss --all` 只解析到 `8.5.23`。
2. `npm audit` 不再报告该 PostCSS 公告。
3. 完整 `npm run verify` 通过，桌面和手机浏览器回归保持通过。
4. Pages 构建产物和播放器行为无功能回归。
