# PWA Update Recovery

## Goal

Make installed/mobile PWA updates predictable and data-safe: detect a real
Service Worker replacement, tell the user that a refresh is available, save
local playback state before refreshing, and prove that an old installation can
upgrade, clean its old cache, retain browser data, and start offline.

## Background

- The Phase-1 quality matrix left old-to-new Service Worker activation as a P1
  gap for the mobile/offline Goal phase.
- Current browser evidence proves only that the already-current shell reloads
  offline. It does not start from an older active worker or inspect cache
  replacement.
- `sw.js` calls `skipWaiting()` and `clients.claim()`, but the page only logs a
  successful registration. A running user receives no update status or safe
  refresh action after a new worker takes control.
- Queue data lives in IndexedDB and recent history/playback state live in
  localStorage. An update must never clear or bypass these stores.

## Requirements

### UR-1: Distinguish first install from an update

Bind the `controllerchange` listener before registration. The first worker that
claims a previously uncontrolled page establishes the baseline and must not
show an update prompt. Replacing an existing controller must show the prompt
exactly once for that page lifetime.

### UR-2: Accessible, user-controlled update prompt

Show one compact notification shared by desktop and mobile with:

- a clear `播放器已更新` status;
- a `刷新` command;
- a `稍后`/dismiss command;
- status/live-region semantics and stable layout at `1280x800`, `390x844`, and
  the existing narrow mobile regression width.

Do not force an automatic reload while the user may be editing a queue or
listening. Dismissing affects only the current page; a future launch naturally
uses the active worker.

### UR-3: Save state before update reload

When the user chooses refresh, disable repeat activation, flush the pending
queue write, force the current playback-session save when it is valid, and only
then reload. A storage warning may be logged, but the user must not be trapped
on a disabled control.

### UR-4: Safe cache replacement

The new worker must finish caching every core asset before activation succeeds.
On activation it removes older `cplayer5-*` caches, keeps unrelated origin
caches, trims the bounded cover cache, and claims clients. Advance the cache
name when the production HTML/Service Worker changes.

### UR-5: Deterministic upgrade browser proof

Use a test-only static server and an older Worker fixture to exercise the real
browser boundary:

1. register and activate the old Worker at the app root scope;
2. seed an old CPlayer cache, an unrelated cache, IndexedDB queue data, and
   localStorage history;
3. open the real app so it registers the current `sw.js`;
4. observe controller replacement and the update prompt;
5. prove old-cache deletion, current-core-cache readiness, and unrelated-cache
   preservation;
6. switch offline, use the real refresh command, and prove the shell plus queue
   and recent history survive.

The fixture and server live under `tests/e2e/`; production code has no test mode
and no live third-party network dependency is introduced.

### UR-6: Executable contracts and release gate

Extend the frontend quality specification and feature verifier with the update
lifecycle contract. `npm run verify` remains the single release gate.

## Acceptance Criteria

- [x] First Service Worker installation does not display an update prompt.
- [x] Replacing an existing controller displays one accessible update prompt
      on desktop and mobile layouts, with working refresh and dismiss actions.
- [x] Refresh waits for queue persistence and preserves valid playback state
      before reloading.
- [x] A real old-to-current Worker browser test proves controller replacement,
      old CPlayer cache cleanup, current core-cache readiness, unrelated-cache
      preservation, and offline shell reload.
- [x] The same upgrade test proves IndexedDB queue and localStorage recent
      history survive intact.
- [x] Test infrastructure stays under `tests/e2e/`; production has no fixture
      branch and Pages deployment does not include the old Worker fixture.
- [x] Service Worker cache revision, static feature contracts, README/spec/task
      records, and generated CSS stay synchronized.
- [x] `npm run verify` and `git diff --check` pass; visual evidence covers
      desktop `1280x800` and mobile `390x844` without overlap or truncation.

## Out of Scope

- Offline music streaming or audio-file caching.
- Proving real Android/iOS background playback and power-management behavior.
- Automatically reloading without the user's command.
- Changing IndexedDB schemas or deleting any user-owned browser storage.
- Push, deployment, or production cache observation without user confirmation.
