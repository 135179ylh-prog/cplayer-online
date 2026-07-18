# Verification - cplayer-online

## 已验证
- 后台播放：浏览器切后台继续播放
- 播放列表：刷新后恢复
- 自建歌单：新建/加入/播放/删除
- 歌单排序：管理详情可打开，上移/下移和移除会写回 IndexedDB；刷新后顺序保持；首尾边界按钮禁用
- 播放模式：4 种切换正常
- 手机布局：华为 Pura X 阔折叠适配

## 2026-07-18 歌单排序验证
- `python check_recent.py`：成功提取主内联脚本到 `_check.js`。
- `node --check _check.js`：退出码 0。
- `git diff --check`：退出码 0（仅换行提示，无空白错误）。
- Chrome CDP（本地 `http://127.0.0.1:4173/`）：设置弹窗可见；详情顺序从 `One, Two, Three` 下移为 `Two, One, Three`，UI 与 IndexedDB 一致，刷新后仍保持。
- Chrome CDP：第一首“上移”和最后一首“下移”均禁用；测试数据与测试标签已清理。
- Chrome CDP：空歌单显示 `0 首` 与空状态、禁用“播放整单”；单曲歌单同时禁用上移/下移。
- 视觉检查：桌面详情弹窗无按钮/文本重叠，截图保存在对应 Trellis 任务的 `research/chrome-detail.png`。
- 基线告警：仓库未包含 `playlist.js`，本地浏览器会有既存 404；Tailwind 运行时也会提示 CDN 生产告警，本轮未新增这两项。

## 待验证
- 最近播放列表
- 导出/导入歌单备份
- 播放失败自动跳过
