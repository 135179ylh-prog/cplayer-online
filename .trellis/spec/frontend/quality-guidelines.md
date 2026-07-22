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
IndexedDB CPlayer5DB v4, store `playlists` (keyPath id):
  id === 'current_queue'   -> the play queue record
  id startsWith 'user_pl_' -> user playlists
  other ids                -> cached remote playlists
localStorage:
  cp_recent_history   -> recent-play list (max 50, newest first)
  cp_queue_dirty='1'  -> legacy compatibility marker; does not gate restore
  cp_playback_session -> resume position
```

The queue, user playlists, and remote-cached playlists share one object store
and are disambiguated only by id prefix. A test that inspects the store must
filter by id.

### 3. Contracts

- Adding a searched song to the queue must persist the `current_queue` record
  with its queue revision and may set `cp_queue_dirty='1'` for compatibility.
  On reload any valid queue record restores before a saved remote playlist,
  regardless of that marker; an emptied queue must not stale-restore.
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
| Song added, then reload with or without `cp_queue_dirty` | Queue restores identical order and contents from IndexedDB. |
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

## Browser Storage Resilience Contract

### 1. Scope / Trigger

This contract applies whenever localStorage, IndexedDB schema/opening,
queue/user-playlist writes, disposable caches, multi-tab persistence, or a
Service Worker cache lookup changes. Normal round-trip coverage is insufficient:
the browser may deny storage, abort a transaction, block an upgrade, close a
connection for `versionchange`, or exhaust the shared origin quota.

### 2. Signatures

```js
readLocalStorage(key, fallback = null) // -> string | fallback; never throws
writeLocalStorage(key, value)          // -> boolean; never throws
removeLocalStorage(key)                // -> boolean; never throws

initDatabase()                         // -> Promise<IDBDatabase>
transactionDone(tx)                    // resolves complete; rejects error/abort
runCriticalStorageWrite(operation)     // one quota cleanup + retry
pruneTransientCaches(aggressive)       // never deletes user-owned records
```

`CPlayer5DB` is version 4. The existing stores remain `playlists`, `lyrics`, and
`images`; version 4 adds `images.index('timestamp')` without replacing data.

The queue record is backward-compatible and may include:

```js
{
  id: 'current_queue',
  songs, currentIndex, playMode, timestamp, reason,
  revision, // non-negative monotonic integer; missing legacy value means 0
  writerId  // random id for the page runtime
}
```

Runtime storage status is exposed as
`document.documentElement.dataset.cplayerStorageState` with `ready`,
`degraded`, `blocked`, `conflict`, or `stale`.

### 3. Contracts

- Every production `localStorage.getItem`, `setItem`, and `removeItem` call lives
  inside the three safe helpers. A denied read uses its fallback and queues one
  warning; it must not terminate module evaluation.
- `initDatabase` owns one in-flight open request. `request.onblocked` rejects the
  startup wait so the application shell can finish. A late success after that
  rejection is closed instead of becoming the active connection.
- Every accepted connection closes itself on `versionchange`, clears the module
  reference, enters `stale`, and tells the user to refresh. A blocked/stale page
  must not keep opening or writing through the old database version.
- A valid `current_queue` IndexedDB record is restored before `cp_playlistId`.
  `cp_queue_dirty` is compatibility metadata, never the authority that hides a
  valid queue record.
- Queue save is compare-and-set in one `readwrite` transaction. It reads the
  current revision, rejects a newer foreign writer, and only then writes revision
  + 1. A conflict blocks later saves from that stale page until refresh.
- A critical queue/user-playlist quota error may delete all disposable image and
  remote-playlist cache records and retry once. It must never delete
  `current_queue` or any `user_pl_*` record.
- Normal cache limits are 160 `images` records and 12 remote `playlists` records.
  Cache ordering uses `timestamp`; user-owned records are excluded by id before
  any delete.
- Image and remote-playlist caching is best effort. A cache write failure cannot
  turn an already loaded image or online playlist into an overall load failure.
- The Service Worker routes `apikey` URLs and path segments `163_search`,
  `163_music`, `163_lyric`, and `163_playlist` network-only before cache access.
  All app reads use the current `CACHE_NAME` instance, never global
  `caches.match`, so preserved unrelated caches cannot supply app content.
- Storage failure probes live in Playwright init scripts/pages only. Production
  code has no fixture flag, injected failure branch, or exported test-only API.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| localStorage throws `SecurityError` during module start | App reaches ready with defaults; state `degraded`; warn that changes may not persist. |
| Version-3 connection holds a version-4 upgrade | State `blocked`; tell user to close other pages; app shell becomes ready. |
| Active connection receives `versionchange` | Close it, clear `db`, state `stale`, request refresh; later queue write does not persist. |
| Queue record exists but `cp_queue_dirty` does not | Restore the IndexedDB queue, including an intentionally empty queue. |
| Another page saved a newer queue revision | Abort stale transaction; state `conflict`; winning record remains byte-for-byte unchanged. |
| First critical write throws `QuotaExceededError` | Aggressively prune disposable caches and retry exactly once. |
| Retry still throws quota | State `degraded`; show storage-space failure; do not claim persistence. |
| Optional cache write fails after online playlist fetch | Keep/render fetched songs; report cache/storage health separately. |
| Cache exceeds normal limits | Keep newest 160 images / 12 remote lists; preserve queue and user playlists. |
| Key-free same-origin `/163_*` request | Network response changes normally and no current/unrelated cache entry is read or written. |
| Unrelated cache contains the same app URL | Ignore it; use current app cache or network. |

### 5. Good / Base / Bad Cases

- Good: two pages load revision 0; page A commits revision 1; page B's stale save
  aborts and direct IndexedDB inspection still equals A's record.
- Base: a version-3 database upgrades to version 4, preserves queue/user records,
  creates the image timestamp index, and normal queue CRUD still round-trips.
- Bad: catch an IndexedDB error, log it, continue showing a success toast, and
  later let a stale `cp_queue_dirty` flag restore an older queue.

### 6. Tests Required

- Browser-only storage failure suite with Service Workers blocked: localStorage
  `SecurityError`, real v3/v4 `blocked`, real v4/v5 `versionchange`, two-page
  queue conflict, quota retry/persistent failure, and cache-limit preservation.
- Assert both browser boundary state and persisted state. A toast or dataset alone
  does not prove the queue/user record survived.
- Optional remote-cache failure test must drive a successful mocked playlist
  response through the real UI and reject only the IndexedDB cache `put`.
- Service Worker suite uses controlled 200 responses and proves both repeated
  network changes and absence from current/unrelated caches.
- Existing queue, playlist, backup, Service Worker upgrade/offline, desktop, and
  mobile regressions must remain green after a database/cache revision change.

### 7. Wrong vs Correct

```js
// Wrong: module-start storage denial prevents every feature from loading.
const quality = localStorage.getItem('cp_quality') || 'jymaster';

// Correct: safe fallback records degraded health but keeps startup alive.
const quality = readLocalStorage('cp_quality', 'jymaster') || 'jymaster';
```

```js
// Wrong: whole-record last writer silently destroys another tab's queue.
store.put(payload);

// Correct: read and compare revision in the same readwrite transaction,
// then put only when the page still owns the base revision.
const readRequest = store.get('current_queue');
readRequest.onsuccess = () => {
  const latestRevision = normalizeQueueRevision(readRequest.result?.revision);
  if (latestRevision > queueBaseRevision) {
    tx.abort();
    return;
  }
  store.put({ ...payload, revision: latestRevision + 1, writerId: QUEUE_WRITER_ID });
};
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

## User-Configured ChKSz API Contract

### 1. Scope / Trigger

This contract applies whenever a ChKSz endpoint, API base URL, API credential,
request retry rule, or auth-related UI feedback changes. The app is a public
static site, so it cannot hide a shared secret in shipped HTML or JavaScript.

### 2. Signatures

```js
ChKSzAPI.normalizeBaseUrl(value)
// -> normalized absolute HTTP(S) base without trailing slash, or ''

ChKSzAPI.buildUrl(path, params = {})
// -> URL using the effective base and optional runtime `apikey`

fetchJsonWithTimeout(url, timeoutMs)
// -> parsed JSON, or throws an error with status 401/403 for auth failures
```

The browser-owned storage keys are `cp_api_key` and `cp_api_base`. The default
base remains the value of `meta[name="cplayer-api-base-url"]`.

### 3. Contracts

- Read the key only from `localStorage`. Never place a real or fixed key in
  source, tests, documentation, build configuration, or committed artifacts.
- Search, song URL, lyric, and remote-playlist requests must all call
  `ChKSzAPI.buildUrl`; no endpoint may append `apikey` independently.
- `buildUrl` uses `URLSearchParams`, includes a trimmed non-empty key as the
  query parameter named exactly `apikey`, and omits it when the key is empty.
- The Service Worker must route every URL containing the `apikey` query
  parameter directly to the network before any `caches.match` call. This rule is
  hostname-independent so a same-origin custom proxy cannot persist the key in
  CacheStorage.
- A custom base must be an absolute HTTP(S) URL with a hostname and without
  credentials, query, or fragment. Invalid stored data falls back to the
  default base; saving the default removes the redundant `cp_api_base` key.
- Normalize both HTTP 401/403 and HTTP 200 JSON `{ code: 401|403 }` into the
  same auth failure. Auth failures are not retried and must not make playback
  skip otherwise playable queue entries.
- The UI message is `API 密钥无效或额度已用完，请在设置中检查密钥`. Search keeps
  its query and recovery control; remote-playlist and lyric paths must not
  replace this message with a generic empty-result or ID error.
- The settings copy must say that the value stays in this browser but is sent
  to the selected API in the request URL. Do not describe localStorage as
  network secrecy.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| No stored key or base | Use the `.top` default and send no `apikey`. |
| Key contains reserved URL characters | Preserve the value through URL encoding and decoding. |
| Custom base is malformed or has credentials/query/fragment | Reject save; do not partially persist the key or base. |
| Stored custom base is invalid | Ignore it and display/use the default base. |
| HTTP status is 401 or 403 | Throw a non-retryable auth error and show the actionable message. |
| HTTP is 200 and JSON code is 401 or 403 | Produce the same auth behavior as an HTTP auth status. |
| Playback gets an auth error | Pause/stop recovery; do not request the next queue item. |
| Settings reset | Remove both storage keys; subsequent requests use the default without `apikey`. |
| Same-origin custom base sends `apikey` | Network response is used; no cached response is read or written for that URL. |

### 5. Good / Base / Bad Cases

- Good: a runtime-generated test key containing `+`, `/`, and `?` is saved,
  then a routed search request decodes to the identical `apikey` value.
- Base: with no saved settings, search still targets the existing `.top` base
  exactly as before and has no `apikey` query parameter.
- Bad: one caller builds `${base}/163_music?...&apikey=${key}` directly, or an
  auth error is treated as an empty playlist and replaced by an ID error.

### 6. Tests Required

- Unit: classify 401/403 and key-related upstream messages as `auth`; assert
  that 401/403 is not retryable.
- Feature contract: assert all four endpoint paths use `ChKSzAPI.buildUrl`, the
  storage keys are runtime reads/writes, and no production source has a fixed
  `apikey` literal value.
- Browser, desktop `1280x800` and mobile `390x844`: save a runtime-generated
  key and custom base, inspect the routed request URL, cover HTTP and JSON auth
  responses, reject an invalid base atomically, verify remote-playlist auth
  feedback, and reset to a key-free default request.
- Route-mocked tests set `serviceWorkers: 'block'`; generated keys and route
  payloads must not use a real credential or call the live service.
- Service Worker browser test: preseed a same-origin keyed URL with a marker
  response, fetch it under the active Worker, prove the network response wins,
  delete the entry, fetch again, and prove the URL is still absent from every
  application cache.

### 7. Wrong vs Correct

```js
// Wrong: leaks a fixed value and lets endpoint behavior drift.
const url = base + '/163_music?id=' + id + '&apikey=fixed-value';

// Correct: the centralized builder reads optional runtime browser state.
const url = ChKSzAPI.buildUrl('/163_music', { id, level });
```

## Deterministic Playback and Runtime Lifecycle Contract

### 1. Scope / Trigger

This contract applies whenever the main `Audio` source, playback request flow,
resume session, queue-empty behavior, Media Session actions, application boot,
or a continuous canvas/WebGL animation changes. A song requested from the API is
not necessarily the media currently loaded in the browser.

### 2. Signatures

```js
activePlaybackAttempt
// pending async work; changes before the song API resolves

committedMedia
// { token, songId, source, ready }; owns the main Audio source

commitMediaIdentity(attempt, source)
resetPlaybackIdentity()

seekMainAudio(target, options)
// options.fastSeek is optional and defaults to false
syncVisualLifecycle()

document.documentElement.dataset.cplayerReady = 'true'
window.dispatchEvent(new CustomEvent('cplayer:ready'))
```

Browser tests install `Audio`, Media Session, and animation probes with
`page.addInitScript` before navigation. The main audio object remains a real
`HTMLAudioElement`; production has no test-mode branch and does not add a DOM
`<audio>` solely for inspection.

### 3. Contracts

- `activePlaybackAttempt` cancels stale network/lyric/cover work only. Resume
  persistence must never take a song id from it.
- `committedMedia` changes only when a playable URL is assigned to the main
  `Audio`. It becomes ready on real `loadedmetadata` or `play`, and its normalized
  source must still match the audio source before time/duration can be saved.
- `savePlaybackSession` resolves the queue index from `committedMedia.songId`.
  During a pending song-B request, page hide may save song A only as song A; it
  must never write song B with song A's clock.
- Page and system play commands resume the committed source even when a newer
  request is pending. An `ended` event resolves its queue index from committed
  media and returns without advancing when a different attempt is pending.
- Replacing `audio.src` synchronizes paused UI, Media Session, and visual state
  before autoplay. Policy/abort failures repeat that synchronization when the
  native element is paused, so the next user play command remains usable.
- Final-item removal and explicit queue clearing call the same reset owner. Reset
  invalidates the attempt token before pausing/unloading main and preload audio,
  clears the resume record, metadata, position state, and playback state, and
  leaves an earlier captured system `play` handler unable to revive the source.
- `seekto`, `seekbackward`, `seekforward`, keyboard progress, and pointer progress
  share one finite clamping boundary. Missing forward/back offsets default to 10
  seconds; explicitly invalid, non-positive, or infinite offsets are ignored.
- Media Session position state is published only for a committed ready source
  with finite positive duration/rate and position inside `[0, duration]`. A new
  source and a reset clear the old position state.
- The app-ready signal is emitted once, after IndexedDB/queue restore, core event
  registration, update setup, synchronous mobile UI construction, and Media
  Session handler registration. Tests do not infer readiness from an unrelated
  global function.
- A continuous renderer owns at most one request id. Audio-reactive work requires
  an analyser, active playback, and a visible document. Fluid background work
  requires active playback and visibility; pause/hide cancels pending frames,
  and repeated visible events cannot start duplicate loops. A visible resize
  while paused redraws one static WebGL frame without starting a loop.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Song A plays while song B API response is pending | Lifecycle save uses A id/index/time, or safely declines; never B plus A time. |
| A is paused while B is pending, then system play fires | Resume A's committed source without cancelling B. |
| A ends while user-selected B is pending | Stop A's visual/system state and keep waiting for B; do not request C. |
| Replacing A with B is autoplay-blocked | Audio, UI, Media Session, and visuals remain paused; a later play can retry B. |
| New source is assigned but metadata is not ready | Clear old system position; do not persist a new resume snapshot yet. |
| Last queue song is removed | Queue stays empty; both audio sources are unloaded; system metadata/position cleared and playback state is `none`. |
| Captured pre-reset system play handler is invoked | No new `audio.play()` call and no source restoration. |
| Absolute seek is negative / above duration | Clamp to `0` / `duration`. |
| Absolute target or explicit offset is `NaN`, infinite, zero, or negative | Ignore it and leave current time unchanged. |
| Back/forward offset is absent | Move by the 10-second default within media bounds. |
| Page boots with persisted queue | Ready signal waits until restored queue and mobile/system handlers are usable. |
| Playback is paused or document is hidden | Continuous visual request count settles; pending visual frame is cancelled. |
| Visible playback resumes or visibility event repeats | Start exactly one visual loop, never one loop per event. |
| Visible viewport resizes while paused | Redraw one WebGL frame, then keep the request count settled. |

### 5. Good / Base / Bad Cases

- Good: hold song B at the routed `/163_music` boundary, give real probed song A
  a 61-second clock, dispatch `pagehide`, and assert the persisted record is A at
  61 seconds before releasing B.
- Base: invoke system forward seek without an offset at 40/120 seconds and observe
  50 seconds plus a valid `{ duration, position, playbackRate }` update.
- Bad: query `document.querySelector('audio')` and treat `null` as paused, use
  `activePlaybackAttempt.songId` with `audio.currentTime`, or call
  `requestAnimationFrame` before checking whether useful work exists.

### 6. Tests Required

- Unit: `clampMediaSeekTime` covers normal, boundary, negative, over-duration,
  non-number, non-finite, and invalid-duration inputs.
- Browser desktop `1280x800` and mobile `390x844`: explicit ready plus queue
  restore; pending-request session ownership; final-item source/system cleanup;
  committed resume and ended-event ownership while another request is pending;
  blocked-autoplay state recovery; captured play invalidation; bounded Media
  Session absolute/default/custom and invalid seeks; position-state publication
  and reset.
- Playback-error browser test must inspect the captured first `Audio` instance
  and fail if no real instance exists; a missing DOM element is not evidence.
- Animation browser test instruments request/cancel/execute counts before
  navigation and proves paused, play, pause, hidden, visible, and repeated-visible
  transitions plus paused resize redraw without relying on the browser's own
  hidden-page throttling.
- Static contract verifies the ready ordering, committed-media/reset owners,
  shared seek path, visual lifecycle owner, and presence of the boundary tests.

### 7. Wrong vs Correct

```js
// Wrong: pending request identity is paired with the old Audio clock.
const songId = activePlaybackAttempt.songId;
save({ songId, currentTime: audio.currentTime });

// Correct: only ready media still bound to the Audio source can own progress.
if (committedMedia.ready && committedMedia.source === audio.src) {
    save({
        songId: committedMedia.songId,
        currentTime: audio.currentTime
    });
}
```

## PWA Update Lifecycle Contract

### 1. Scope / Trigger

This contract applies whenever `index.html`, `sw.js`, the Service Worker cache
name/core asset list, update UI, browser-storage flush behavior, or PWA browser
tests change. A static source check cannot prove that an active older Worker is
replaced safely.

### 2. Signatures

```js
setupServiceWorkerUpdates()
// binds controllerchange before registering ./sw.js

showAppUpdatePrompt()
// displays one update notification per page lifetime

reloadForAppUpdate()
// awaits queue flush, saves valid playback state, then reloads
```

Playwright uses `node tests/e2e/server.mjs 4173`. The test-only old Worker is
`/tests/e2e/fixtures/sw-old.js`; only that response receives
`Service-Worker-Allowed: /`.

### 3. Contracts

- Remember whether `navigator.serviceWorker.controller` exists before
  registration. A first claim establishes the baseline; replacing an existing
  controller displays the update notification exactly once.
- Await `loadDefaultPlaylist()` before calling `setupServiceWorkerUpdates()`.
  The notification must not become actionable while the persisted queue is
  still being restored into memory.
- Never auto-reload on `controllerchange`. The user owns refresh timing through
  `刷新`; `稍后刷新` hides the prompt for the current page.
- Before reload, await `flushScheduledQueueSave('sw_update_reload')`, then call
  `savePlaybackSession('sw_update_reload', true)`. Reuse these storage owners;
  do not write IndexedDB/localStorage directly in update UI code.
- Every production precache change advances `CACHE_NAME`. Install succeeds only
  after all core assets are available from network or an older cache.
- Activation deletes only older `cplayer5-*` caches, preserves unrelated
  origin caches, trims the current cover cache, then calls `clients.claim()`
  inside the same `event.waitUntil` chain.
- `controllerchange` proves controller replacement, not immediate Cache Storage
  list visibility. Browser tests poll the old-cache absence condition without a
  fixed sleep.
- The Worker never deletes or migrates IndexedDB/localStorage. Upgrade tests
  prove queue, recent history, and playback-session survival through an offline
  reload.
- The old Worker fixture and test server stay below `tests/e2e/` and must not be
  present in the Pages artifact.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Page starts without a controller | First claim stays silent; update prompt remains hidden. |
| Existing controller is replaced | Show one accessible prompt with refresh and dismiss actions. |
| User dismisses | Hide prompt; do not reload or modify browser data. |
| User refreshes repeatedly | One save/reload sequence; refresh control stays disabled while saving. |
| Pending queue write exists | Await the shared queue saver before reload. |
| Playback progress is invalid | Shared saver safely declines it; reload still proceeds. |
| Older `cplayer5-*` cache exists | Delete it during current Worker activation. |
| Unrelated origin cache exists | Preserve it. |
| Network is offline after upgrade | Current cached app shell loads and stored queue/history remain readable. |
| Old fixture lacks root-scope response header | Test setup is invalid; fix the test server, not production scope logic. |

### 5. Good / Base / Bad Cases

- Good: activate the test old Worker, seed real Cache Storage/IndexedDB/
  localStorage, open the real app, observe the current Worker, go offline, click
  the real refresh command, and assert shell plus data round trips.
- Base: a fresh browser context installs the current Worker and never displays
  an update prompt.
- Bad: seed an old cache without an old active controller, duplicate current
  Worker cleanup logic in a fixture, auto-reload on every controller change, or
  assert cache deletion immediately without a condition wait.

### 6. Tests Required

- Startup in desktop `1280x800` and mobile `390x844`: current shell renders,
  no unexpected runtime error, update prompt hidden on first install.
- Old-to-current upgrade in both viewport projects: controller script changes
  from the fixture to `/sw.js`; prompt is visible and accessible; current core
  cache exists; old CPlayer cache disappears; unrelated cache remains.
- Refresh path: switch offline, click `刷新`, wait for navigation, assert the
  app shell and build badge, then read both `window.playlist` and the IndexedDB
  `current_queue` record plus recent/playback localStorage.
- Dismiss path: click `稍后刷新`, assert prompt hidden, URL unchanged, and app
  still usable.
- Syntax/feature gate: parse the test server, fixture, Worker, and main module;
  assert custom server ownership, scoped header, update markers, cache revision,
  and Pages fixture exclusion.

### 7. Wrong vs Correct

```js
// Wrong: claims clients before activation cleanup has completed.
event.waitUntil(deleteOldCaches());
self.clients.claim();

// Correct: cleanup, trim, and claim form one activation transaction.
event.waitUntil(
  deleteOldCaches()
    .then(trimCurrentCache)
    .then(() => self.clients.claim())
);
```

## Responsive Accessibility Contract

### 1. Scope / Trigger

This applies whenever a dialog, drawer/sheet, tab set, player control, dynamic
song row, viewport breakpoint, or focus behavior changes. Visual presence is
not proof of operability: touch, keyboard, and accessibility-tree state must be
verified independently.

### 2. Signatures

```js
openAccessibleOverlay(modal, { close, initialFocus, closeOnEscape = true })
closeAccessibleOverlay(modal)

setAccessibleTabState(tab, panel, isActive)
bindArrowTabNavigation(tabList, tabs, activate)

syncProgressAccessibility(element, currentTime, duration)
handleProgressKeydown(event)
```

The browser matrix is desktop `1280x800`, mobile `390x844`, narrow mobile
`355x800`, and wide foldable `440x707`. The last two projects run only
`responsive-accessibility.spec.mjs`; they do not multiply storage and PWA
flows that are already covered by desktop/mobile.

### 3. Contracts

- Dialogs form one LIFO stack. Opening records the current focus, moves focus
  inside, and makes every unrelated body child `inert`. Tab/Shift+Tab stay in
  the top dialog; Escape closes only that dialog; closing restores its opener.
- Animated dialogs remain on the stack until they are actually hidden. Do not
  restore background focus at the start of a fade-out.
- Closed desktop/mobile panels have `aria-hidden="true"` and `inert=true`;
  their trigger has `aria-expanded="false"`. Opening reverses all three and
  focuses the active tab. Escape closes the panel only when no dialog is open.
- Tabs use `tablist`/`tab`/`tabpanel`, roving `tabindex`, `aria-selected`, and
  left/right/Home/End navigation. Inactive panels are hidden and inert.
- Playback progress uses slider semantics and exposes percent plus readable
  elapsed/total time. Arrow keys seek five seconds; Home/End seek to the media
  boundaries. No duration means `aria-disabled="true"`.
- Mobile cover/lyrics views have an explicit 44px toggle. The inactive view is
  `aria-hidden` and inert; swipe/click shortcuts are additional, not exclusive.
- A song row with secondary actions uses a native primary play button plus
  sibling action buttons. Never put nested buttons inside a click-only row.
- Visible mobile buttons, tabs, and row actions are at least `44x44` CSS px.
  All four target viewports have no document-level horizontal overflow or
  clipped interactive targets.
- The viewport meta must allow browser zoom. Never add `user-scalable=no` or a
  restrictive `maximum-scale`.
- Delayed focus must not steal focus after the user moves elsewhere. Prefer the
  next animation frame and re-check active tab/panel/focus ownership first.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Playlist detail opens above the library | One Escape closes detail only; library remains and regains focus. |
| Dialog is open | Background layouts/panels are inert and cannot receive Tab or pointer input. |
| Drawer/sheet is translated off-screen | It is also aria-hidden and inert; transform alone is insufficient. |
| Tab changes | Old panel becomes hidden/inert; new panel and tab attributes change together. |
| Media duration is unavailable | Slider stays at zero and reports disabled; keyboard seek is a no-op. |
| Mobile autoplay is blocked | Progress keyboard test accepts the already-paused state and still uses real metadata. |
| Dialog opacity is transitioning | Axe scan waits for final opacity `1`; final state must have no serious/critical violation. |
| Viewport is 355, 390, or 440px wide | No visible interactive target is below 44px or outside the viewport. |

### 5. Good / Base / Bad Cases

- Good: the user opens Library, opens playlist detail, presses Escape once,
  continues in Library, then presses Escape again and returns to the opener.
- Base: a closed mobile sheet is visually off-screen, inert, aria-hidden, and
  its trigger reports collapsed.
- Bad: each dialog owns a document Escape listener, a delayed search focus
  overrides a result button, or a 44px `min-width` is added to eight controls
  still squeezed into one 355px row.

### 6. Tests Required

- Axe Playwright: shell and open Settings have zero critical/serious violations
  in all four viewport projects.
- Geometry: root width does not overflow; visible mobile interactive targets
  are at least 44px and remain inside the viewport.
- Focus: Settings contains Tab, Escape hides it after animation, and focus
  returns to the desktop/mobile opener.
- Layers: nested playlist detail closes one level at a time.
- Panels/tabs: hidden/inert/expanded states round-trip; ArrowRight changes the
  selected tab; Escape returns focus to the trigger.
- Progress: a Range-capable mocked audio boundary supplies real metadata;
  ArrowRight/Home/End update slider time and percent.
- Dynamic songs: the primary search result is a native button and Enter reaches
  the mocked song API boundary. External ChKSz availability is never used.

### 7. Wrong vs Correct

```js
// Wrong: visually hidden but still keyboard-accessible; delayed focus can win later.
panel.classList.add('translate-x-full');
setTimeout(() => searchInput.focus(), 100);

// Correct: visual and accessibility state move together; focus ownership is re-checked.
panel.classList.add('translate-x-full');
panel.inert = true;
panel.setAttribute('aria-hidden', 'true');
requestAnimationFrame(() => {
  if (activeTab === 'search' && document.activeElement === searchTab) searchInput.focus();
});
```

## Main Application Module Contract

### 1. Scope / Trigger

This applies whenever the main runtime script entry, `js/app.js`,
`js/core-utils.js`, Tailwind content paths, Service Worker core assets, Pages
artifact rules, or the module syntax checker changes. The HTML entry, module
import graph, generated CSS, offline cache, and deployment artifact are one
cross-layer loading contract.

### 2. Signatures

```html
<script type="module" src="./js/app.js"></script>
```

```js
// js/app.js, resolved relative to the module file itself
import { /* shared pure helpers */ } from './core-utils.js';
```

`scripts/check_module_syntax.py` runs `node --check js/app.js` against the
actual production file. It must not reconstruct the module from HTML or check a
temporary copy.

### 3. Contracts

- `index.html` owns DOM and inline page styles. It contains exactly one
  external main ES module entry and no inline main application module.
- `js/app.js` owns browser application behavior. Moving it must not change
  initialization order, global exports, API behavior, or storage contracts.
- Static relative imports resolve from `js/app.js`; the core utility import is
  `./core-utils.js`, not the old HTML-relative `./js/core-utils.js`.
- Classic dependencies such as `js/color-thief.umd.js` and `playlist.js`
  load before the module entry. Keep `type="module"` deferred execution; do
  not replace it with `async` or a classic script.
- `tailwind.config.cjs` scans `index.html`, `playlist-downloader.html`, and
  `js/app.js`. Dynamic row/control class strings are production CSS inputs.
- `sw.js` precaches both `./js/app.js` and `./js/core-utils.js`. Any
  precached production change advances `CACHE_NAME`.
- Pages copies the complete `js/` directory. The static feature gate verifies
  the external entry, source ownership, Tailwind scan, cache entry, and artifact
  source together.
- Resource splitting is not itself proof of faster first load. Record byte
  sizes and request boundaries; do not set machine-time thresholds without a
  stable measurement environment.

### 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| HTML has no `./js/app.js` module entry | Static gate fails before browser tests. |
| `js/app.js` uses `./js/core-utils.js` | Module request resolves incorrectly; static import-path gate must fail. |
| App module is absent from Tailwind content | Static gate fails so dynamic utilities cannot be purged silently. |
| App module is absent from Service Worker core assets | Static gate and upgrade-cache browser assertion fail. |
| App module has invalid syntax | Direct `node --check js/app.js` fails. |
| Old Worker upgrades to the current cache | Current cache contains `/js/app.js`; offline reload reaches the app-ready API. |
| Fresh desktop or mobile navigation | Exactly one `/js/app.js` resource is loaded as JavaScript and the app reaches ready state. |
| Module extraction changes product behavior | Existing deterministic full browser suite fails; do not patch around it with test-only production branches. |

### 5. Good / Base / Bad Cases

- Good: mechanically extract the existing module, update the single relative
  import, syntax owner, Tailwind scan, cache revision, and upgrade assertions,
  then prove normalized old/new module text is equal.
- Base: a normal feature edit changes only `js/app.js`; the direct syntax
  check and browser suite run without rewriting or reparsing HTML.
- Bad: keep a stale inline copy, check whichever script block happens to be
  longest, omit `js/app.js` from Tailwind, or rely on runtime cache fill for
  offline installation.

### 6. Tests Required

- Syntax: `node --check js/app.js`, with exactly one recent-history key
  definition reported by the checker.
- Static contract: external module entry, no inline main module, correct import,
  Tailwind scan path, Service Worker cache entry/revision, and Pages `js/`
  artifact ownership.
- Browser desktop `1280x800` and mobile `390x844`: app module responds once
  with JavaScript content type and reaches `waitForAppReady`.
- Service Worker upgrade desktop/mobile: current cache contains
  `/js/app.js`; refresh while offline still restores the shell and browser
  data.
- Full release gate: all existing API, playback, queue, playlist, backup,
  update, responsive, and accessibility flows remain green.

### 7. Wrong vs Correct

```html
<!-- Wrong: application behavior stays embedded in the HTML document. -->
<script type="module">
  import { normalizeSongObject } from './js/core-utils.js';
</script>

<!-- Correct: one production module entry with its own cache boundary. -->
<script type="module" src="./js/app.js"></script>
```
