# Storage resilience

## Goal

Keep the player usable when browser storage is denied, blocked, upgraded, full,
or concurrently edited. User-owned queue and playlist data must take priority
over disposable caches, and storage failures must never be silent.

## Background

- A module-startup `localStorage` read can currently throw before event handlers
  or the explicit app-ready signal are registered.
- `indexedDB.open()` has no blocked/version-change lifecycle handling, so a
  database upgrade held by another tab can keep startup pending forever.
- Queue contents live in IndexedDB while `cp_queue_dirty` in localStorage decides
  whether they are restored. The two writes are not atomic.
- Two open tabs can overwrite the complete queue record without detecting that
  the other tab saved a newer revision.
- IndexedDB thumbnail and remote-playlist caches have no bound and share origin
  quota with user playlists and the current queue.
- The Service Worker can cache key-free same-origin `/163_*` API responses and
  can read matching entries from unrelated CacheStorage namespaces.

## Requirements

- Route every production localStorage read, write, and removal through one safe
  boundary. A `SecurityError` or quota failure must fall back to in-memory
  defaults, keep the application bootable, and surface one actionable warning.
- Upgrade `CPlayer5DB` compatibly and manage one in-flight open request. A blocked
  upgrade must release application startup; `versionchange` must close the stale
  connection and prevent further writes from using it.
- Treat the IndexedDB `current_queue` record as the restore source of truth. The
  legacy `cp_queue_dirty` key may remain for backward compatibility but cannot
  decide whether a valid queue record is ignored.
- Store a monotonic queue revision and runtime writer id. In one read/write
  transaction, reject a stale tab before it can overwrite a newer queue record.
  The winning persisted record must remain intact and the stale tab must receive
  clear feedback.
- Use one transaction-completion helper that settles on `complete`, `error`, or
  `abort`. Critical queue/user-playlist writes may evict only disposable caches
  and retry once after a quota error.
- Bound IndexedDB thumbnails to 160 entries and remote-playlist cache records to
  12 entries. Never evict `current_queue` or any `user_pl_*` record.
- Cache writes are optional acceleration. A thumbnail or remote-playlist cache
  failure must not invalidate an image already loaded or an online playlist
  already rendered.
- Route dynamic `/163_search`, `/163_music`, `/163_lyric`, and `/163_playlist`
  requests directly to the network even when no API key is present. Cache reads
  must be scoped to the current application cache, not unrelated namespaces.
- Keep all tests deterministic: mock browser storage or network boundaries only,
  use generated values, and add no production test switch.

## Acceptance Criteria

- [x] With localStorage methods throwing `SecurityError`, the module reaches
  `data-cplayer-ready="true"`, core controls work, storage status is degraded,
  and the user sees that changes may not persist.
- [x] A held version-3 database connection causes the version-4 app to report a
  blocked upgrade and become ready instead of hanging.
- [x] A later database version change closes the stale app connection and gives
  a refresh instruction; no old connection is used for subsequent writes.
- [x] A valid legacy/current queue record restores even when
  `cp_queue_dirty` is absent or unavailable.
- [x] Two simultaneously opened pages cannot silently overwrite the newer queue:
  the stale write is rejected and the persisted winner is unchanged.
- [x] Normal and aggressive pruning remove only disposable image/remote-playlist
  records; image count is at most 160, remote cache count at most 12, and queue
  plus user playlists survive byte-for-byte.
- [x] A simulated quota failure prunes disposable data and retries a critical
  queue write once; a persistent failure is reported without claiming success.
- [x] Online playlist rendering succeeds even when its optional cache write
  fails.
- [x] Key-free same-origin `/163_*` responses bypass CacheStorage, and an
  unrelated cache entry with the same URL cannot poison application reads.
- [x] Unit, syntax, static contracts, focused browser tests, full browser suite,
  dependency audit, CSS freshness, and whitespace checks pass.
- [x] Contracts and verification evidence are updated; no push, deployment, live
  third-party request, or real API credential is used.

## Out Of Scope

- Automatically merging divergent queue or playlist edits across tabs.
- Synchronizing another tab's UI in real time; this milestone prevents silent
  overwrite and instructs the stale page to refresh.
- Requesting persistent browser storage, changing backup format, or changing
  user-playlist record ids.
- Proving OEM/private-mode quota sizes on physical devices.
