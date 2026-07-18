# AGENTS.md

## 项目概览

**名称**：cplayer-online  
**目标**：把 ChKSz CPlayer 改造成手机可用的在线音乐播放器，支持：
- 后台播放
- 播放列表持久化
- 自建歌单（新建/加入/播放/删除）
- 4 种播放模式（顺序/单曲/列表循环/随机）
- 跨网络访问（GitHub Pages）

**线上地址**：https://135179ylh-prog.github.io/cplayer-online/  
**仓库**：https://github.com/135179ylh-prog/cplayer-online

---

## 维护约定

1. **所有任务文档放 `.trellis/tasks/`**
   - `prd.md`：需求
   - `design.md`：设计
   - `implementation-plan.md`：实施计划
   - `research.md`：研究记录
   - `verification.md`：验证结果

2. **每次改动都要更新对应文档**
   - 改了功能 → 更新 `prd.md` / `design.md`
   - 改了计划 → 更新 `implementation-plan.md`
   - 做了验证 → 更新 `verification.md`

3. **提交信息格式**
   - `feat: ...` 新功能
   - `fix: ...` 修复
   - `docs: ...` 文档
   - `chore: ...` 杂项

4. **部署**
   - 推送 `main` 后自动触发 GitHub Pages 部署
   - 也可手动：`gh workflow run --repo 135179ylh-prog/cplayer-online pages.yml`

---

## 当前状态

- [x] 后台播放修复
- [x] 播放列表持久化
- [x] 自建歌单（新建/加入/播放/删除）
- [x] 4 种播放模式
- [x] 手机端布局适配（华为 Pura X 阔折叠）
- [ ] 歌单内歌曲排序
- [ ] 最近播放列表
- [ ] 导出/导入歌单备份
- [ ] 播放失败自动跳过

---

## 如何继续

1. 读取本文件
2. 读取 `.trellis/tasks/` 下对应文档
3. 按 `implementation-plan.md` 继续
