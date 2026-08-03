# 设计：PostCSS 安全公告修复

## 依赖关系

`tailwindcss@3.4.17` 及其 PostCSS 插件通过 peer 依赖共享同一个 PostCSS 实例。将修复版本作为直接开发依赖固定，可让 npm 在锁文件中统一解析到 `8.5.23`，不改变线上运行时依赖。

## 风险控制

- 只修改 `package.json` 和 `package-lock.json` 的开发依赖解析。
- CSS 构建、静态契约、Pages artifact 和全量浏览器测试作为回归边界。
- 不升级 Tailwind 主版本，避免引入无关样式变化。
