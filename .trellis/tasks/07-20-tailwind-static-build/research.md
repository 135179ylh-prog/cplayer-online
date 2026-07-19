# Research - Tailwind 运行时审查

## 已核实

- `js/tailwindcss.js` 为 407,362-byte Tailwind Play CDN runtime，内嵌版本 3.4.17；主页面在 head 中同步加载。
- `playlist-downloader.html` 直接加载 `https://cdn.tailwindcss.com`。
- `package.json` 只有 Node 测试脚本，没有 lockfile、Tailwind 配置、构建工具或本地依赖。
- 两个 HTML 是所有 Tailwind utility 的扫描来源；当前动态 UI 使用的 utility 值均以源码字面量出现，未发现需要 safelist 的动态拼接类名。
- `sw.js` 将旧 `./js/tailwindcss.js` 作为 core asset 预缓存，缓存优先策略要求迁移时同时替换 asset 并升级 cache name。
- Pages staging artifact 已复制整个 `css/` 与 `js/` 目录，因此提交静态 CSS 后不需要修改白名单。

## 实施观察

- `npm run build:css` 生成 `css/tailwind.css`，大小 27,815 bytes；旧 `js/tailwindcss.js` 为 407,362 bytes，运行时下载与浏览器 JIT 工作已移除。
- 迁移前主页面的 Tailwind runtime style 在已有内联 style 之后注入；静态 link 放在内联 style 后，保持该层叠关系。
- 迁移前后主页面的 `body` 颜色、`#fluidBg` 定位、`.fixed`、`.flex` 和 `.rounded-xl` 计算样式一致。
- 在 390 x 844 的同源 iframe 视口中，`#mobileLayout` 为 `flex`、`#desktopLayout` 为 `none`，移动控制按钮数量为 12，确认响应式断点仍生效。
- 更新后的本地 Service Worker 激活 `cplayer5-v48-static-tailwind`，其 core cache 只包含 `/css/tailwind.css`，不含旧 runtime bundle。

## 风险和缓解

- CSS 级联顺序会影响自定义样式和 utility 覆盖关系：通过在两个页面的现有内联 style 后加载静态 CSS，并用真实浏览器检查。
- 后续新增非字面量 utility class 可能被构建遗漏：内容范围和构建脚本显式可见，静态验证检查页面引用。
- Service Worker 客户端可能缓存旧壳：升级 cache name 并保留激活清理策略。
