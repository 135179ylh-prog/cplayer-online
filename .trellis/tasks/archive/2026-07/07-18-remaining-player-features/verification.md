# Verification - 剩余播放与备份功能

## Status

实现与验证完成，所有验收项通过。

## Static Gates

- `python check_recent.py`：主内联脚本成功生成 `_check.js`，`RECENT_HISTORY_KEY count 1`。
- `node --check _check.js`：退出码 0。
- `node --check sw.js`：退出码 0。
- `git diff --check`：退出码 0，仅有工作区换行提示。
- 自定义结构断言：最近播放键、`audio.error` 绑定、桌面模式单绑定、资料库控件、`v28` 与 SW `v42` 均唯一且存在；源码不存在旧模式比较。
- HTML5 解析：0 个解析错误；137 个真实 DOM id 无重复；`settingsDropZone` 为 `DIV`，资料库位于 `body`。
- `python ./.trellis/scripts/task.py validate .trellis/tasks/07-18-remaining-player-features`：通过。

## Browser Verification

- Chrome CDP / `http://127.0.0.1:4173/`，复用用户现有 Chrome，在 Codex 自建后台标签中验证并在结束后关闭。
- 最近播放：52 次真实 `play` 事件最终保留 50 条；`recent-10` 重播后位于顶部且仅出现一次；`recent-0/1` 被裁剪；暂停后继续播放未增加重复记录。
- 音乐资料库：桌面 2327×1146 与移动弹窗 355×715 均无横向溢出；移动新建与备份按钮无相交，最近播放封面、文本、播放按钮保持同一行。
- 备份导出：文件名为 `cplayer-playlists-2026-07-18.json`，格式、版本、导出时间、歌单名称和歌曲顺序正确。
- 备份导入：现有 1 个歌单基础上导入 2 个，得到 3 个；同名生成“Codex 验收歌单 (导入)”，歌曲 `C / D` 顺序保持。
- 非法导入：缺少歌手字段、错误版本和 5 MB + 1 字节文件均被拒绝；非法歌曲测试前后 IndexedDB 始终为 3 个歌单，没有半写入记录。
- 自动跳过：`bad-api → bad-url → bad-play → media-error → good` 各尝试一次，只有 `good` 进入最近播放。
- 全失败：列表循环与随机模式均在所有候选各尝试一次后停止并提示；顺序模式在末尾失败后不回绕。
- 模式边界：列表循环和单曲循环遇到坏歌会跳到其他候选；`NotAllowedError` 只尝试当前歌曲，不请求下一首，也不写最近播放。
- 旧值迁移：`random → shuffle`、`single → repeat_one`；桌面模式按钮单击一次分别只前进到 `sequence` 和 `repeat_all`。
- 浏览器测试创建的歌单、最近记录、当前队列、临时超大文件和后台标签均已清理。

## Visual Evidence

- `research/library-desktop-v28.png`
- `research/library-mobile-v28.png`
- `research/recent-mobile-v28.png`
