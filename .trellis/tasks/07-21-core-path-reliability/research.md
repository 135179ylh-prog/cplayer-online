# Research - Core-Path Reliability

## Updated Evidence Matrix

This supersedes the Phase 1 matrix for the flows worked in Phase 2. Strength is
raised only where a deterministic browser test now exercises real browser
storage and the mocked ChKSz boundary.

| Flow | Evidence after Phase 2 | Strength | Remaining gap | Phase |
| --- | --- | --- | --- | --- |
| Search | desktop/mobile failure-to-retry browser tests (Phase 1) | High | add/play ordering breadth | later |
| Playback | failing song-URL browser test proves clear error + no stuck state + no unhandled error; utility tests for classification | Medium-High | real-media resume/progress persistence needs device automation | later |
| Queue | add persists to IndexedDB `current_queue` and survives reload; removal clears record and stays empty | High | multi-item reorder round-trip | later |
| User playlists | create/delete round-trip through IndexedDB; confirm-dismiss keeps data; empty-name rejected | Medium-High | reorder/move browser proof | later |
| Recent history | render caps at 50, drops invalid-id entries, clear empties storage | Medium | record-time dedupe-on-play (play-driven) | device gate |
| Backup restore | valid import adds `user_pl_` records; invalid format + malformed JSON rejected atomically with existing data intact | High | very-large-file boundary case | later |
| Offline shell | active-controller online-to-offline reload (Phase 1) | High | old-to-new cache upgrade | 3 |
| Update flow | cache naming/cleanup source checks | Low | old-to-new cache activation test | 3 |

## Confirmed Storage Contracts

Captured from `index.html` during this task (see the test-contract reference in
agent memory for exact line citations):

- IndexedDB `CPlayer5DB` v3, single `playlists` store keyed by `id`.
  - Play queue = record `id === 'current_queue'`.
  - User playlists = records with `id` prefix `user_pl_`.
- Queue autosave is debounced 250ms and sets `localStorage['cp_queue_dirty']='1'`;
  restore-on-load reads `current_queue` when the dirty flag is set.
- Recent history lives in `localStorage['cp_recent_history']`, capped at 50,
  newest-first, deduped by stringified id at record time.
- Backup import (`parsePlaylistBackup`) validates fully before any DB write and
  commits inside one `readwrite` transaction, so a rejected import cannot
  partially overwrite data. Import is additive: imported playlists get fresh
  `user_pl_` ids and de-duplicated names, never overwriting existing records.

## Decisions

- Drive flows through the real UI where a stable control exists (search add
  buttons, library create/delete, backup file input); use exposed `window`
  APIs (`removeSongFromQueue`, `playSongAtIndex`) only where the DOM is
  virtualized or otherwise unreliable to click.
- Assert against real IndexedDB/localStorage reads, not just in-memory state.
- Keep production code free of any test-only branch; inject only at the network
  boundary and via seeded browser storage.

## Phase 3 Input

1. Old-to-new Service Worker cache activation and cleanup under a version bump.
2. Update-available prompt and controlled reload behavior.
3. Cache-upgrade data migration safety for stored queue/playlist records.
