# Design - cplayer-online

## 架构
- 纯前端 PWA（index.html + sw.js + manifest.json）
- IndexedDB 存储：播放列表、歌单
- GitHub Pages 部署

## 关键设计
- 后台播放：不使用 createMediaElementSource，保持原生 audio 路径
- 播放模式：PLAY_MODES 数组循环切换
- 歌单管理：myPlaylistsModal 页面，支持新建/播放/删除
- 歌单排序：playlistDetailModal 读取自建歌单的 songs 数组，上移/下移交换相邻元素后写回 IndexedDB；保存期间禁用操作，首尾按钮按边界禁用
- 手机适配：safe-area-inset，按钮加大，布局下移
- 模态框样式使用 cplayer-modal-backdrop 专用命名，避免浏览器扩展对通用 .modal-backdrop 注入规则造成冲突

## 文件结构
- index.html：主页面（含所有 JS）
- sw.js：Service Worker 缓存
- manifest.json：PWA 配置
- .trellis/tasks/：任务文档
