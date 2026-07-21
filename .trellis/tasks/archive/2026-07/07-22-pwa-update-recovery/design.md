# Design - PWA Update Recovery

## Lifecycle Flow

```text
page starts
  -> initialize IndexedDB and await queue/default-playlist restore
  -> bind controllerchange before register
  -> remember whether a controller already exists
  -> register ./sw.js with updateViaCache:none
  -> first install claim: establish baseline only
  -> existing controller replaced: show update notification once
  -> user dismisses OR chooses refresh
  -> refresh: flush queue -> save playback session -> location.reload()
```

Automatic reload is deliberately excluded. `skipWaiting()` and
`clients.claim()` make the new worker active quickly, while the page remains in
control of when its DOM/JavaScript is replaced.

## UI Contract

Add one unframed fixed notification near the top safe area, separate from the
short-lived toast. It contains a status icon, short status/copy, a text command
for `刷新`, and an icon dismiss button with an accessible label. It remains
hidden in normal startup and cannot resize the underlying player layout.

The refresh button enters a stable disabled/busy state so repeated taps cannot
start competing writes or reloads. Dismiss hides only this notification.

## Persistence Boundary

`reloadForAppUpdate()` reuses existing owners rather than duplicating storage
logic:

```text
UI command
  -> flushScheduledQueueSave('sw_update_reload')
     -> saveCurrentQueue() -> IndexedDB CPlayer5DB/playlists/current_queue
  -> savePlaybackSession('sw_update_reload', true)
     -> localStorage cp_playback_session when current progress is valid
  -> window.location.reload()
```

Recent history and user playlists need no write during update; the Worker never
touches localStorage or IndexedDB. The browser regression seeds queue/history
before the upgrade and reads them after an offline reload.

## Cache Boundary

- `install`: open only the current `CACHE_NAME`; every core asset must be
  available from network or a previous cache before installation succeeds.
- `activate`: delete only caches whose names start with `cplayer5-` and differ
  from the current cache. Preserve unrelated origin caches.
- `fetch`: current navigation fallback and local-asset strategies remain
  unchanged.

Changing `index.html` and `sw.js` advances the cache name to the next revision.

## Deterministic Browser Harness

`tests/e2e/server.mjs` replaces Python's generic static server for Playwright.
It serves repository files without caching and adds
`Service-Worker-Allowed: /` only to the old Worker fixture path. That lets the
fixture register at root scope without placing it at the repository root or in
the Pages artifact.

The fixture implements only an old installation boundary: create an old
`cplayer5-*` cache, activate, claim. The new side is always the real root
`sw.js`; no current Worker logic is copied into the test.

## Compatibility and Rollback

- No browser-data schema or production URL changes.
- Browsers without Service Worker support keep current behavior and never show
  the notification.
- Rollback reverts the feature commit. Existing current caches remain valid;
  a later cache revision naturally replaces them.
- The explicit Pages allowlist remains unchanged and excludes `tests/`.
