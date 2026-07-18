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
- [x] 歌单内歌曲排序
- [x] 最近播放列表
- [x] 导出/导入歌单备份
- [x] 播放失败自动跳过

---

## 如何继续

1. 读取本文件
2. 读取 `.trellis/tasks/` 下对应文档
3. 按 `implementation-plan.md` 继续

<!-- CODEX-CLAUDE-DUO:START -->
## Codex + Claude Code Collaboration

- The current Codex desktop conversation is the lead orchestrator and sole product-code writer.
- For complex coding, second-opinion, or cross-model review requests, use `$codex-claude-duo`.
- Claude Code participates only through the skill's read-only peer runner; it may analyze and review but must not edit product code.
- Prefer the runner's interactive `terminal` mode in a Codex-owned PTY. Keep one-shot `analysis` and `review` only as compatibility fallbacks.
- Never use YOLO, `bypassPermissions`, or a write-capable Claude worker in this workflow.
- Before implementation, read `.trellis/workflow.md` and the relevant `.trellis/spec/` guidance, then keep the task lifecycle under `.trellis/tasks/`.
- Do not run `abg duo`; it starts a separate Codex CLI process instead of using the current desktop conversation.
- Do not use Trellis 0.6.6's Claude channel adapter for the default review path because that adapter enables bypass permissions.
- Keep Codex and Claude model, provider, context, and reasoning options unset so each CLI inherits CCSwitch and native configuration.
- Keep task state, plans, research, review artifacts, and recovery state under `.trellis/`.
- Invoke project skills with `$skill-name` (for example `$trellis-start` or `$codex-claude-duo`), not `/trellis`.
<!-- CODEX-CLAUDE-DUO:END -->
