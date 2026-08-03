# 研究：PostCSS 安全公告修复

## 证据

- 当前锁文件解析到 `postcss@8.5.20`，来源是 `tailwindcss@3.4.17` 的构建依赖树。
- GitHub Advisory `GHSA-fxqj-rqcc-2cmp` / `CVE-2026-69153` 标记 `<= 8.5.22` 受影响，修复版本为 `8.5.23`。
- 公告描述的是未设置 `from` 时，攻击者控制 CSS 注释中的外部 `sourceMappingURL` 可能读取 `.map` 文件；本项目只对仓库内受控 Tailwind 源文件做构建，线上不运行 PostCSS。

## 方案取舍

- 直接固定修复版本，不使用宽泛的 `npm audit fix`，避免无关依赖漂移。
- 保持 Tailwind `3.4.17` 不变，只修复其共享的 PostCSS 实例。
