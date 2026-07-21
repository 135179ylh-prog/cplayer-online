# Quality Guidelines

## Playback Quality Metadata Contract

### 1. Scope / Trigger

This applies whenever a song response, a requested quality level, or either
desktop/mobile quality badge changes. The upstream API can make a requested
quality unavailable, so a request preference is not proof of the delivered
audio quality.

### 2. Signatures

```js
classifyPlaybackQuality({ level, url, bitrate })
// -> { text, className, icon, detail, source }

renderPlaybackQuality(qualityInfo)
// updates #qualityBadge and #mobileQualityBadge together
```

`MusicService.getSong(id, requestedLevel)` returns a song object with an
explicit upstream `level` string or `null`, plus `url` and optional `br`.

### 3. Contracts

- `requestedLevel` is sent to the API only. Never copy it into the returned
  `level` field or render it as delivered quality.
- Trust a recognized API `level` first. Show it as `标注 ...` and identify the
  API in the accessible detail text.
- Without a recognized API level, infer only `无损`, `高音质`, or `标准` from a
  `.flac` URL pathname or a bitrate expressed in bps. Never infer JyMaster or
  Hi-Res from a URL or bitrate.
- A bare value such as `320` has no reliable unit and must not be treated as
  320 kbps. No usable evidence renders `音质未标注`.
- Rendering must update text, class, `title`, and `aria-label` on both badges
  in the same function. Only the active playback request may render a result.

### 4. Validation & Error Matrix

| Input or state | Required result |
| --- | --- |
| `d.level` is not a string | Return `level: null`; do not fall back to the request parameter. |
| Recognized API level | API-labelled result takes priority. |
| Unknown API level | Continue to conservative URL/bitrate inference. |
| Empty, non-finite, or `< 128000` bitrate | Do not infer from bitrate. |
| `.flac` pathname or bitrate `>= 900000` | Infer `无损`. |
| Bitrate `>= 192000` / `>= 128000` | Infer `高音质` / `标准`. |
| No trustworthy metadata | Render `音质未标注`; do not leave a previous badge visible. |

### 5. Good / Base / Bad Cases

- Good: API returns `jymaster`; show `标注 JyMaster` with API provenance.
- Base: API omits `level` and returns `320000`; show inferred `高音质`.
- Bad: API omits `level` and the request was `jymaster`; do not show JyMaster.

### 6. Tests Required

- Unit-test API labels, 320000 bps, a bare `320`, FLAC inference, and unknown
  data through `classifyPlaybackQuality`.
- Feature verification must reject requested-level backfill and old hard-coded
  JyMaster loading text.
- Browser verification must confirm desktop and mobile badges have the same
  state and accessible description in both wide and narrow layouts.

### 7. Wrong vs Correct

```js
// Wrong: turns a request preference into claimed playback metadata.
level: d.level || requestedLevel

// Correct: only preserve an explicit upstream label.
level: typeof d.level === 'string' ? d.level : null
```

## Code Review Checklist

- Check that a new quality mapping has a source and an accessible explanation.
- Check that no pre-load or stale request can overwrite the active song badge.
- Check the Service Worker cache version whenever static badge code changes.

## Core-Flow Storage Contract

### 1. Scope / Trigger

This contract applies whenever the play queue, user playlists, recent history,
or backup import/export changes. All four persist in browser storage, so a
source-string check is not proof; each change needs a browser round-trip test
that reads real storage.

### 2. Storage Map

```text
IndexedDB CPlayer5DB v3, store `playlists` (keyPath id):
  id === 'current_queue'   -> the play queue record
  id startsWith 'user_pl_' -> user playlists
  other ids                -> cached remote playlists
localStorage:
  cp_recent_history   -> recent-play list (max 50, newest first)
  cp_queue_dirty='1'  -> set on every queue save; gates restore on reload
  cp_playback_session -> resume position
```

The queue, user playlists, and remote-cached playlists share one object store
and are disambiguated only by id prefix. A test that inspects the store must
filter by id.

### 3. Contracts

- Adding a searched song to the queue must persist the `current_queue` record
  and set `cp_queue_dirty='1'`. On reload the queue restores from IndexedDB
  when the dirty flag is set; an emptied queue must not stale-restore.
- Backup import is additive and atomic: imported playlists receive freshly
  minted `user_pl_` ids and de-duplicated names, all `put` calls run in one
  `readwrite` transaction, and validation throws before any DB access. A
  rejected import must leave every existing playlist unchanged.
- Backup import validation surfaces a specific error toast (`不是有效的 JSON
  文件`, `不是 CPlayer 歌单备份`, `不支持的备份版本`, ...); the test asserts the
  exact message, not just toast visibility.
- Recent history de-duplicates by stringified id, keeps newest-first order, and
  is capped at `RECENT_HISTORY_LIMIT` (50) on both read and write. Entries
  without a valid id are dropped on read.
- Recording a recent play is driven by the real audio `play` event, so it is
  not deterministically testable without real media. Cover the read/render
  invariants (cap, invalid-drop, clear) via seeded `localStorage` instead.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Song added, then reload with `cp_queue_dirty='1'` | Queue restores identical order and contents from IndexedDB. |
| Only queued song removed, then reload | Queue stays empty; no stale restore. |
| Valid backup imported | New `user_pl_` records added; queue untouched; toast `已导入 N 个歌单`. |
| Invalid/corrupt backup imported | No DB write; existing playlists identical (count, id, songs); specific error toast. |
| Recent history over 50 entries | Read and render cap at 50, newest first. |
| Recent history entry has no valid id | Dropped on read; not rendered. |

### 5. Good / Base / Bad Cases

- Good: a queue test adds via the real add button, polls `readQueueRecord`
  until the debounced save lands, reloads, and asserts restored contents.
- Base: a playlist-CRUD test creates and deletes through the library UI and
  confirms the `user_pl_` record count in IndexedDB across a reload.
- Bad: a backup test asserts only that a toast appeared, or reads in-memory
  `window.playlist` instead of the persisted record.

### 6. Tests Required

- Queue: add persists and survives reload; removal clears storage and stays
  empty after reload. Both desktop and mobile.
- Backup: valid import adds `user_pl_` records; invalid import and malformed
  JSON are rejected atomically with the existing playlist intact.
- User playlists: create/delete round-trip through IndexedDB; dismissed delete
  confirm keeps the playlist; empty name is rejected.
- Recent history: render caps at 50; invalid-id entries dropped; clear empties
  storage.
- Playback error: a mocked failing `/163_music` response surfaces a clear error
  toast, clears the loader, leaves audio paused, and raises no unexpected
  runtime error beyond the injected failure.

### 7. Wrong vs Correct

```js
// Wrong: asserts in-memory state, not persistence; misses a save/restore bug.
expect(await page.evaluate(() => window.playlist.length)).toBe(1);

// Correct: asserts the persisted IndexedDB record and reload restore.
await expect.poll(async () => (await readQueueRecord(page))?.songs.length).toBe(1);
await page.reload();
await expect.poll(() => page.evaluate(() => window.playlist.length)).toBe(1);
```

## Release Quality Gate Contract

### 1. Scope / Trigger

This contract applies whenever production HTML, CSS, JavaScript, the Service
Worker, manifest, storage behavior, API-driven UI, tests, or the Pages workflow
changes. Source-string checks alone are not acceptable evidence for a rendered
user flow.

### 2. Signatures

```text
npm run verify   # complete local and CI release gate
npm run test:e2e # deterministic Chromium browser regression only
```

The browser configuration is `playwright.config.mjs`. Failure screenshots,
videos, traces, and the HTML report are written below `output/playwright/`.

### 3. Contracts

- `npm run verify` must stop on the first failed layer and run the CSS build,
  CSS freshness comparison, unit tests, main-module syntax, Service Worker
  syntax, feature contracts, high-severity dependency audit, browser tests,
  and `git diff --check`.
- `css/tailwind.css` is committed build output. The gate snapshots it before
  the build and fails if the build changes it.
- Browser coverage uses deterministic desktop `1280x800` and mobile `390x844`
  Chromium projects. PWA tests run sequentially to avoid competing Service
  Worker installation/activation on the same test origin.
- Tests that use `page.route` to mock ChKSz requests must set
  `serviceWorkers: 'block'`; otherwise the Service Worker owns the request and
  bypasses the Playwright page route. Offline-shell tests must allow the
  Service Worker and wait for `navigator.serviceWorker.controller`.
- External API failures and successes are injected at the network boundary.
  Production code must not contain a test mode or fixture branch.
- `.github/workflows/pages.yml` must run the quality job from locked npm
  dependencies and make the deploy job depend on it with `needs: quality`.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Tailwind source and committed CSS differ | Gate fails after rebuilding and asks for the generated file to be reviewed. |
| Unit, syntax, contract, audit, or browser command exits non-zero | Gate stops and preserves the failing command's output. |
| Search API is mocked while Service Worker is active | Invalid test setup; block the Service Worker for that test file. |
| Offline-shell test has no active controller | Wait on controller state; never replace it with a fixed sleep. |
| Live ChKSz service is unavailable | Deterministic CI remains unaffected because user-flow tests use route fixtures. |
| Quality job fails | Pages deploy job must not start. |

### 5. Good / Base / Bad Cases

- Good: a search test holds the mocked service in a failed state, asserts the
  recovery UI, changes the mock to success, clicks the visible retry control,
  and asserts the result in both viewports.
- Base: a pure helper change is covered by Node tests and still runs the full
  release gate before commit.
- Bad: a test calls the live API, accepts any non-crashing page as success, or
  sleeps a fixed number of milliseconds for Service Worker activation.

### 6. Tests Required

- Startup: desktop and mobile shells are visible and collect no unexpected
  `pageerror` or console error.
- Search recovery: desktop and mobile retain the query and open panel across
  an injected failure, expose an accessible retry button, and render the
  injected successful result after retry.
- Offline shell: an active-controller context reloads once online, switches
  offline, reloads again, and still renders the local app shell.
- Any new critical flow must be added to the task quality matrix and promoted
  from static/manual evidence to browser evidence in the owning Goal phase.

### 7. Wrong vs Correct

```js
// Wrong: the Service Worker bypasses this route, so the test can hit production.
test('search recovery', async ({ page }) => {
    await page.route(/163_search/, mockSearch);
});

// Correct: the deterministic network owner is explicit for route-mocked tests.
test.use({ serviceWorkers: 'block' });
test('search recovery', async ({ page }) => {
    await page.route(/163_search/, mockSearch);
});
```
