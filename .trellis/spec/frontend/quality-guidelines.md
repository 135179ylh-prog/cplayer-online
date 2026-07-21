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

### 7. Wrong vs Correct

```js
// Wrong: leaks a fixed value and lets endpoint behavior drift.
const url = base + '/163_music?id=' + id + '&apikey=fixed-value';

// Correct: the centralized builder reads optional runtime browser state.
const url = ChKSzAPI.buildUrl('/163_music', { id, level });
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
