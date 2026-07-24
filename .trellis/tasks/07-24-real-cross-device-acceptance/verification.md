# Verification - 真实跨设备验收

## Environment

- Date: 2026-07-24 (Asia/Shanghai)
- Production URL: `https://135179ylh-prog.github.io/cplayer-online/`
- Device A: desktop Chrome 150 on Windows 10/11, user-managed profile.
- Device B: physical mobile browser (model/version not recorded)
- Account: same user-managed real account; email/password/token are not recorded.
- Test playlist: `跨设备验收-20260724-2309`
- Test playlist id: `user_pl_mrxuhho92ygg2lw`

## Acceptance Timeline

| Step | Device | Expected | Evidence | Status |
| --- | --- | --- | --- | --- |
| Baseline | A/B | synced, pending 0, conflicts 0 | A DOM + B user report | passed |
| Create/order | A→B | same id/name/3 song ids/order | A DOM + B user report | passed |
| Reverse edit | B→A | new order propagates | A read-only IndexedDB | passed |
| Offline edit | B | local survives, pending >0→0 | B report + A read-only DB | passed |
| Real conflict | B offline + A online | conflict, no silent overwrite | B panel + A read-only DB | passed |
| Resolution | B→A | selected version converges | B report + A read-only DB | passed |
| Delete/cleanup | A→B | test row removed, other lists unchanged | A DB + B report | passed |
| Automated gate | local/CI | focused + full verify pass | fresh command output | passed |
| Release | Pages | exact commit deploy + live read-only check | workflow/live | pending |

## Results

### Device A baseline and seed (passed)

- Production loaded in a separate background tab without changing any existing
  browser tab.
- The first local-only library read showed 0 playlists before cloud hydration;
  after the signed-in session completed hydration, the read-only store contained
  3 pre-existing cloud playlists plus the dedicated test playlist. The test did
  not modify queue, recent history, progress, or API settings.
- Status center: `synced`, pending `0`, conflicts `0`.
- Cache Storage contained only `cplayer5-v64-sync-status`; the active service
  worker was the production `sw.js`.
- Created the dedicated test playlist and added exactly three songs in order:
  `294052`, `1346093339`, `2697934851`.
- After upload, Device A returned to `synced`, pending `0`, conflicts `0`.
- Seed snapshot of the 3 pre-existing playlists (id → song count):
  `user_pl_mrqdmjfqfki25` → 18, `user_pl_mrs84oafeifu7ho` → 28,
  `user_pl_mrtupr92zygpgcz` → 29. These rows are out of test scope and must be
  byte-for-byte unchanged after cleanup.

### Fresh production read-only check (passed)

- A new background tab at the production URL restored the user's real signed-in
  session. The account email was intentionally not recorded.
- Settings status center showed `已同步`, pending `0`, conflicts `0`, and a
  recent-success timestamp.
- The visible library contained 4 rows: the 3 pre-existing playlists above and
  `跨设备验收-20260724-2309` with exactly 3 songs.
- No button that mutates data was activated during this check.

### Device B baseline (user-confirmed)

- The user confirmed that the physical phone shows the same account and status as
  Device A: signed in, `已同步`, pending `0`, conflicts `0`.
- Credentials and device identifiers were not recorded.
- Later checkpoints below record the playlist row, ordered songs, offline state,
  conflict panel, resolution, and cleanup on Device B.

### Device B playlist visibility (user-confirmed)

- The user confirmed that Device B's music library contains
  `跨设备验收-20260724-2309` with `3 首`.
- The user confirmed the order matches Device A:
  `雪落下的声音` → `过春天` → `土坡上的狗尾草 (Live版)`.

### Device B → Device A reorder (passed)

- On Device B, the user moved `土坡上的狗尾草 (Live版)` from position 3 to
  position 1.
- A fresh production background tab on Device A restored the same playlist id
  and read the exact order `2697934851` → `294052` → `1346093339`.
- Device A remained `synced`, pending `0`, conflicts `0`.

### Device B offline attempt 1 (invalid: connectivity remained)

- The user disabled network connectivity on the physical phone while keeping the
  production CPlayer page open and without refreshing it.
- The user then moved `过春天` from position 3 to position 2, producing
  `2697934851` → `1346093339` → `294052`.
- Device B reported `歌单已经是最新状态`, pending `0`, conflicts `0`.
- A fresh Device A read immediately received that exact order as clean cloud
  version 6 with an empty outbox. Therefore Device B still had backend
  connectivity during the mutation; this attempt does not test offline behavior
  and is neither a product pass nor product failure.
- Retry requires independently proving that both Wi-Fi and mobile data are
  unavailable before the playlist mutation.

### Device B verified network isolation (passed)

- For retry 2, the user explicitly disabled both Wi-Fi and mobile data while
  keeping the original CPlayer tab open without refreshing it.
- A newly opened browser tab could not load `https://example.com/`, independently
  proving that the phone had no Internet route before the next mutation.
- While that isolation remained in effect, the user moved `雪落下的声音` from
  position 3 to position 2. Expected local order is now
  `2697934851` → `294052` → `1346093339`.
- Device B then showed `歌单已保存在本机，联网后同步`, pending `1`, conflicts
  `0`. This proves the offline mutation was retained locally and exposed as
  unsynchronized work rather than being silently discarded or reported clean.
- After Device B restored connectivity, the user reported the status changed.
  Device A then received clean cloud version 7 with the exact order
  `2697934851` → `294052` → `1346093339`, pending `0`, conflicts `0`, and an
  empty outbox. The verified offline change therefore recovered automatically.

### Real conflict setup

- Device B again disabled both Wi-Fi and mobile data, kept the original CPlayer
  tab open without refresh, and independently confirmed that a new browser tab
  could not load `https://example.com/`.
- Both devices start from clean cloud version 7 with order
  `2697934851` → `294052` → `1346093339`.
- While still offline, Device B moved `雪落下的声音` to position 1. Its local
  branch order is `294052` → `2697934851` → `1346093339` and has not yet been
  allowed to reconnect.
- Device B confirmed the offline branch is pending `1`, conflicts `0`.
- While Device B stayed offline, Device A moved `过春天` from position 3 to
  position 2. Device A synchronized clean cloud version 8 with order
  `2697934851` → `1346093339` → `294052`, pending `0`, conflicts `0`.
- The two branches now differ from the same version-7 base; Device B must not be
  allowed to overwrite version 8 without an explicit conflict decision.
- After Device B reconnected, the user confirmed that the phone displayed the
  real conflict state with conflict count `1` and did not choose either action.
- A fresh Device A read still showed clean cloud version 8 and the Device A order
  `2697934851` → `1346093339` → `294052`. Device B's stale version therefore did
  not silently overwrite or delete the cloud version.

### Explicit conflict resolution (passed)

- On Device B, the user explicitly selected `使用本机` and waited for the phone
  to return to `synced`, pending `0`, conflicts `0`.
- Device A then received clean cloud version 9 with Device B's exact local order
  `294052` → `2697934851` → `1346093339`, pending `0`, conflicts `0`, and an
  empty outbox. Both devices therefore converged on the chosen branch.

### Cleanup propagation

- Device A deleted only `user_pl_mrxuhho92ygg2lw` through the production UI.
- Device A returned to `synced`, pending `0`, conflicts `0`; the test row was
  absent locally and the outbox was empty after the cloud tombstone completed.
- The 3 pre-existing playlist ids, song counts, and complete ordered song-id
  arrays matched the seed snapshot exactly.
- Device B manually triggered `立即同步`, returned to `synced`, pending `0`,
  conflicts `0`, and the user confirmed the test row disappeared while all 3
  pre-existing playlists remained visible.

### Automated pre-check (passed)

- Command: `npm run test:e2e -- tests/e2e/account-cloud-sync.spec.mjs`
- Result: 24 passed, 0 failed (12 desktop Chromium + 12 mobile Chromium).
- This is a preliminary regression check. If real-device acceptance requires a
  product-code change, the focused suite will be rerun after that change.

### Full quality gate (passed before real-device execution)

- Command: `npm run verify`
- Unit tests: 35 passed, 0 failed.
- Dependency audit: 0 vulnerabilities.
- Pages artifact: 27 files, 18,564,730 bytes.
- Browser regression: 182 passed, 12 expected skips, 0 failed.
- Repository checks: passed.
- This gate will be repeated if the real-device flow leads to a product-code
  change; the final release record will include the post-acceptance run.

### Final automated release gate (passed)

- Focused command: `$env:PW_PORT='4184'; npx playwright test
  tests/e2e/account-cloud-sync.spec.mjs --project=desktop-chromium
  --project=mobile-chromium`
- Focused result: 24 passed, 0 failed (12 desktop + 12 mobile).
- Full command: `$env:PW_PORT='4185'; npm run verify`
- Unit tests: 35 passed, 0 failed.
- Dependency audit: 0 vulnerabilities.
- Pages artifact: 27 files, 18,564,730 bytes.
- Browser regression: 182 passed, 12 expected skips, 0 failed.
- Repository checks: passed; quality gate exit code `0`.
- The Browserslist database emitted an informational staleness notice; dependency
  versions were intentionally left unchanged because this milestone contains no
  product or dependency change.

## Safety Notes

- Do not record credentials, email addresses, auth storage values, API settings, queue contents,
  recent history, or playback progress.
- On failure, keep test data and stop; do not clear storage or edit Supabase rows.
