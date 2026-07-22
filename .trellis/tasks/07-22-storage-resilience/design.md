# Design - Storage resilience

## Storage health boundary

All localStorage access goes through small read/write/remove helpers. They return
fallbacks or booleans instead of throwing and feed a session-level storage health
state. The state is reflected on the root element and shown through the existing
toast once the DOM is ready. API keys remain localStorage-only; no alternate
persistent copy is introduced.

```text
browser storage operation
        |
        +-- success --> normal state
        |
        +-- denied/full --> safe fallback + degraded state + one warning
```

## IndexedDB lifecycle

`initDatabase()` owns one in-flight open promise. Version 4 adds a timestamp
index to the existing `images` store without replacing records. `onblocked`
rejects the startup wait and records a blocked status. Every successful
connection installs `onversionchange`, closes itself, clears the module reference,
and marks the page stale with a refresh instruction.

A late success from an already-rejected blocked request is immediately closed so
it cannot silently replace application state.

## Transaction completion

One `transactionDone(tx)` helper settles exactly once on `complete`, `error`, or
`abort`. Optional cache operations catch their own errors. Critical user-data
writes classify `QuotaExceededError`, prune disposable caches aggressively, and
retry once. No retry deletes the queue or a `user_pl_*` record.

## Queue ownership and conflict detection

The queue record gains compatible optional metadata:

```js
{
  id: 'current_queue',
  songs,
  currentIndex,
  playMode,
  revision,       // monotonically increasing integer
  writerId,       // random id for this page runtime
  timestamp,
  reason
}
```

On restore, the page remembers the record revision. On save, a single read/write
transaction reads the latest record before `put`:

- latest revision equals the page's base revision: write revision + 1;
- latest revision is newer and belongs to another runtime: abort as a conflict;
- legacy records without a revision are revision 0.

This is compare-and-set protection, not automatic merging. A stale page keeps its
in-memory edits but cannot destroy the winner and is told to refresh.

Startup restores a valid `current_queue` before considering `cp_playlistId`.
`cp_queue_dirty` remains a compatibility marker only.

## Disposable cache policy

The database separates records by ownership even though stores remain unchanged:

| Data | Ownership | Policy |
| --- | --- | --- |
| `current_queue` | User state | Never evict |
| `user_pl_*` | User state | Never evict |
| Other `playlists` ids | Remote cache | Keep newest 12 |
| `images` records | Thumbnail cache | Keep newest 160 |

Normal pruning runs after database open and cache writes. Aggressive pruning may
remove all remote/image cache records before one critical-write retry.

## Service Worker boundary

The fetch handler checks credential-bearing requests and known dynamic music API
path segments before any cache access. Those requests are network-only. All app
cache reads use `cache = await caches.open(CACHE_NAME); cache.match(...)` so a
preserved unrelated cache cannot supply application content. The cache revision
advances because `js/app.js` and `sw.js` are precached production assets.

## Test strategy

- Patch browser Storage methods before navigation to throw native-shaped
  `SecurityError` values and assert normal application readiness.
- Hold a real version-3 IndexedDB connection in a second same-origin page to
  exercise `onblocked`; open version 5 after boot to exercise `versionchange`.
- Open two real app pages against the same IndexedDB and prove a stale queue save
  cannot overwrite a newer record.
- Seed real IndexedDB stores above both cache limits, reload, and inspect records
  directly to prove protected data survives.
- Inject a one-shot native-shaped quota failure at the IDB boundary and prove the
  critical write retries; inject a persistent optional-cache failure and prove
  online UI success is retained.
- Install the real Service Worker, seed an unrelated same-URL cache entry, and use
  controlled same-origin responses to prove network-only API behavior and cache
  namespace isolation.

## Compatibility and rollback

- Existing version-3 records remain valid; new queue metadata is optional.
- No user-facing storage key or backup format changes.
- Rolling back code after a version-4 open leaves the database at version 4, so a
  rollback must retain DB version 4/open compatibility even if the new index is
  unused.
- No remote state, push, or deployment is part of this task.
