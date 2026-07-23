# Verification - 同步状态中心

## Environment

- Date: 2026-07-24 (Asia/Shanghai)
- Baseline: `8585ca3`, `main == origin/main`
- Browser matrix: desktop `1280x800`, mobile `390x844`, plus existing responsive
  `355x800`, `440x707`, `844x390`, and `740x360` projects.

## Quality Matrix

| Requirement | Evidence | Status |
| --- | --- | --- |
| 单一状态投影与时间格式 | Node unit tests | passed |
| 成功计数与最近成功 | real IndexedDB + mocked HTTP browser flow, desktop/mobile | passed |
| 离线 outbox 1→0 | real IndexedDB offline/reconnect browser flow | passed |
| 冲突计数与显式选择 | local/remote round-trip browser flow | passed |
| 错误详情与重试 | injected HTTP failure/recovery, desktop/mobile | passed |
| 未配置/未登录本地可用 | browser fallback + existing storage/playback regressions | passed |
| 响应式与无障碍 | six-project responsive/Axe suite | passed |
| 完整发布门禁 | `npm run verify` from exact Pages artifact | passed |
| Pages 与线上冒烟 | exact commit workflow + live read-only browser evidence | pending |

## Results

### Focused Evidence

- `npm test`: 35/35 unit tests passed, including two new status projection/time
  cases and all cloud payload/optimistic merge boundaries.
- Account cloud Playwright on desktop `1280x800` and mobile `390x844`: 24/24
  passed. Real IndexedDB assertions prove pending `1 -> 0`, conflict `1 -> 0`,
  outbox retention through error, retry upload, per-owner last-success storage,
  foreign-owner isolation, deletion tombstones, and local retention.
- Responsive/Axe suite across six projects: 55 passed, 11 expected viewport skips,
  0 failed. Settings focus/inert behavior, 44px targets, safe areas, compact
  landscape, overflow, and serious/critical Axe checks stayed green.
- Focused Pages artifact after cache assertion repair: 4/4 desktop/mobile online
  and offline cases passed with `cplayer5-v64-sync-status`.

### Full Gate

Final `PW_PORT=48789 npm run verify` passed all 10 layers on 2026-07-24:

- committed CSS and pinned Supabase vendor output were fresh;
- 35/35 unit tests passed;
- app module, Service Worker, static feature contracts, and dependency audit
  passed with 0 vulnerabilities;
- Pages artifact contained 27 files and 18,564,730 bytes;
- browser regression ran 194 cases: 182 passed, 12 expected viewport skips,
  0 failed;
- repository check inspected 24 worktree text snapshots and passed UTF-8/no-BOM,
  whitespace, staged, and untracked boundaries.

### Gate Corrections

- First full run: product flows passed, but two release-artifact cases rejected the
  new cache because they duplicated the old `v63` prefix. Removed that duplicate
  version owner; focused 4/4 artifact cases then passed.
- Second full run: 35/35 unit and 182/12 browser results passed; final repository
  layer found UTF-8 BOM in four edited legacy root Trellis docs. Removed only the
  BOM bytes and confirmed each file now starts with `#` (`0x23`).
- Third complete run is the final passing evidence above.

## Rollback

Use a forward fix that preserves CPlayer5DB v5, cloud outbox, and owner metadata.
Do not clear browser data and do not deploy a target that opens DB v4. Run
`npm run check:rollback -- <ref>` before any rollback release.
