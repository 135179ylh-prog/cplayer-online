# Design - 部署与工程卫生加固

## 部署产物

Pages 工作流在上传 artifact 前创建 `_site/`，只复制已知运行时资源：HTML 入口、`sw.js`、`manifest.json`、`playlist.js`、以及 `css/`、`js/`、`img/`、`fonts/` 和 `webfonts/` 目录。`playlist-downloader.html` 暂时保留在产物中，以免破坏已保存的独立工具链接。

这条边界以工作流文件为唯一部署定义，仓库仍可保留符合项目约定的 `.trellis/tasks/` 文档供协作和提交历史使用。

## 本地文件卫生

根 `.gitignore` 只加入本地生成的 agent/Trellis 运行时配置、缓存、Python 字节码和浏览器测试状态。使用精确规则，避免忽略已追踪的工作流和任务文档。

## 无效 headers 配置

GitHub Pages 不解释 Cloudflare/Netlify `_headers` 格式。移除根目录文件，不伪装为已应用的安全或缓存响应头；当前 Service Worker 更新策略继续由 `sw.js` 注册选项和 GitHub Pages 响应行为控制。

## API 边界

README 说明在线 API 是外部单点依赖。服务不可用时，搜索、歌词和在线流媒体相关操作失败；浏览器内已经保存的歌单和队列数据仍保留在本地。
