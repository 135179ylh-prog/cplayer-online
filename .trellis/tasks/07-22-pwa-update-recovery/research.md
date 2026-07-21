# Research - PWA Update Recovery

## Confirmed Gap

The Phase-1 matrix explicitly left two P1 rows for this Goal phase:

- offline shell: current-cache online-to-offline reload is automated, but an
  older cache upgrade is not;
- update flow: cache names and cleanup have static checks only, with no active
  old Worker replaced by the current Worker.

Current registration logs success but has no `controllerchange` UI. Current
`sw.js` already uses `skipWaiting()`, `clients.claim()`, a scoped
`cplayer5-*` cleanup predicate, and complete core-cache installation.

## Data and Ownership Map

```text
Service Worker lifecycle -> Cache Storage only
update notification      -> DOM only
refresh command          -> existing queue saver -> IndexedDB
                         -> existing playback saver -> localStorage
post-upgrade app boot     -> existing queue/history readers
```

The Worker must not read, migrate, or delete IndexedDB/localStorage. Survival
is proved by real browser round trips rather than by adding migration code.

The update registration starts only after `await loadDefaultPlaylist()`. This
prevents a fast controller replacement from exposing the refresh command while
the in-memory queue is still empty and at risk of overwriting the persisted
queue during the pre-reload flush.

## Chosen Test Boundary

Browser routing cannot reliably intercept Service Worker script/update
requests. Duplicating current Worker code into a fixture would create a
tautological test. The selected harness instead:

- serves the repository with a built-in Node HTTP server;
- adds root-scope permission only for an old test fixture;
- activates that fixture first;
- then opens the real application, which registers the real root `sw.js`.

This tests the production replacement path without a production test branch.
The Pages workflow's explicit asset allowlist excludes `tests/`, so neither the
server nor fixture is deployed.

## Error and Edge Cases

- First installation: no update notification.
- Existing controller replaced: notification once.
- Repeated refresh taps: only one persistence/reload sequence.
- Dismiss: notification hidden, no reload.
- Queue write pending: awaited before reload.
- Playback session invalid/near track end: existing saver safely declines it.
- Old CPlayer cache: removed after activation.
- Unrelated cache: preserved.
- Network turned off after activation: current cached shell loads.

## Activation Timing Finding

The first old-to-current regression consistently observed the new controller
and current cache while the old cache name was still listed. The production
cause was an activation boundary split across two operations:

```js
event.waitUntil(cleanupAndTrim());
self.clients.claim();
```

`clients.claim()` now runs at the end of the same `waitUntil` chain. Chromium
can still expose a short Cache Storage list-visibility delay around
`controllerchange`, so the regression waits on the semantic condition (old
cache absent) rather than sleeping or treating controller replacement as proof
of cache-list synchronization. The original failing test reproduced in both
desktop and mobile projects before the fix and condition wait.

## Remaining Device Limit

Chromium emulation can prove responsive UI, Cache Storage, Service Worker,
IndexedDB, and localStorage behavior. It cannot prove Android/iOS background
audio survival or OS-specific PWA update scheduling; those remain release-stage
real-device checks.
