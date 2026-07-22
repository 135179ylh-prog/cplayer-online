# Research - Storage resilience

## Evidence

- `js/app.js:109` reads localStorage during module initialization; a thrown
  `SecurityError` prevents event registration and the ready signal. Additional
  direct access exists at `js/app.js:3882` and in settings/boot flows.
- `js/app.js:273-301` opens IndexedDB without `onblocked` or connection
  `onversionchange`; boot awaits it at `js/app.js:2325-2331`.
- Queue persistence at `js/app.js:692-733` commits IndexedDB and then separately
  writes `cp_queue_dirty`; restore branching at `js/app.js:4096-4108` depends on
  that second store.
- Queue and user playlists are whole-record last-writer-wins writes
  (`js/app.js:699-713`, `js/app.js:1072-1081`) with no stale-writer check.
- IndexedDB images and remote playlists are unbounded (`js/app.js:305-369`) and
  share origin quota with `current_queue` and `user_pl_*` records.
- `js/app.js:4039-4054` renders a fetched online playlist, then lets an optional
  cache write failure fall into the overall load-error branch.
- `sw.js:91-149` bypasses keyed and official-host API requests but can cache a
  key-free same-origin custom API. Multiple global `caches.match()` calls can
  read from unrelated caches that activation intentionally preserves.

## Existing coverage

- Queue, user-playlist, backup, and recent-history tests prove normal storage
  round trips and invalid-data behavior.
- Service Worker update tests prove old application cache cleanup and user-data
  preservation.
- No current test covers Storage `SecurityError`, IDB `blocked`/`versionchange`,
  quota failure, transaction abort, multi-tab overwrite, IndexedDB cache bounds,
  key-free same-origin API caching, or same-URL unrelated-cache poisoning.

## Decisions

- Preserve existing stores and record ids; use a compatible version-4 index.
- Prefer conflict rejection over automatic merging.
- Treat every non-queue/non-user playlist record and every image record as
  disposable cache.
- Keep production free of test modes; all failures are injected at browser
  storage or controlled network boundaries.
