# Verification - 播放器稳定性加固

## 进行中

- 已完成静态语法和真实 Chrome 主路径验证。
- 待重新提取最终主脚本、运行完整静态门禁、验证封面上限与断网启动。
- 待部署后核对线上 `v31` 和 GitHub Pages 工作流。

## 2026-07-19 最终本地验证
- `python verify_features.py`、`node --check _check.js`、`node --check sw.js`、`python -m py_compile verify_features.py` 和 `git diff --check` 通过。
- 隔离 Chrome（`http://127.0.0.1:4183/`）：桌面与移动慢/快搜索只保留最新结果；危险歌名和歌手在两端均作为文本渲染，没有生成 `#qa-xss` 节点。
- 隔离 Chrome：连续加入两首后触发 `pagehide`，IndexedDB `current_queue` 读到 `Queue One、Queue Two` 且保存原因为 `pagehide`；随后清空记录为 0 首。
- 隔离 Chrome：空 `current_queue` 搭配旧 `cp_playlistId` 刷新显示 `(0首)`，没有进入在线歌单加载失败态。
- 隔离 Chrome：封面缓存加入第 161 张后保持 160 张，最旧项淘汰，最新项和真实网易云封面保留。
- 隔离 Chrome：停止本地 HTTP 服务后仍打开 `v31` 播放器，导航传输大小为 0，Service Worker 仍受控；截图 `research/offline-v31.png`。
- 回归修复：访问同域 `playlist-downloader.html` 后，`index.html` 缓存仍含 `v31` 且不含下载器页面内容。

## 待完成
- 推送后核对线上 `v31` 页面、Service Worker 版本和 GitHub Pages 工作流结果。
