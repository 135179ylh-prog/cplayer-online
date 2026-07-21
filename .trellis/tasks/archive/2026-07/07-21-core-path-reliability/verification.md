# Verification - Core-Path Reliability

## Unified Gate

Command: `npm run verify`

Result on 2026-07-21: passed all eight layers.

1. Tailwind CSS build passed and did not change committed `css/tailwind.css`.
2. Node unit tests passed (unchanged from Phase 1).
3. Extracted main-module syntax passed.
4. `sw.js` syntax passed.
5. Static feature contracts passed.
6. `npm audit --audit-level=high` reported 0 vulnerabilities.
7. Playwright regression passed: 29 passed, 0 failed, 1 intentional skip
   (up from 5 passed in Phase 1).
8. `git diff --check` passed.

## New Browser Evidence (Phase 2)

All new tests block the Service Worker (`serviceWorkers: 'block'`) and mock the
ChKSz boundary; none depends on live upstream availability. Each runs in both
`desktop-chromium` (1280x800) and `mobile-chromium` (390x844).

| Spec file | Case | Result |
| --- | --- | --- |
| `queue-roundtrip.spec.mjs` | add persists to IndexedDB `current_queue` and survives reload | Passed (both viewports) |
| `queue-roundtrip.spec.mjs` | removal clears the record and stays empty after reload | Passed (both viewports) |
| `backup-restore.spec.mjs` | valid import writes new `user_pl_` records without touching the queue | Passed (both viewports) |
| `backup-restore.spec.mjs` | invalid format is rejected atomically; existing playlist unchanged | Passed (both viewports) |
| `backup-restore.spec.mjs` | malformed JSON is rejected with no data loss | Passed (both viewports) |
| `playlist-crud.spec.mjs` | create and delete round-trip through IndexedDB | Passed (both viewports) |
| `playlist-crud.spec.mjs` | dismissing the delete confirm keeps the playlist | Passed (both viewports) |
| `playlist-crud.spec.mjs` | empty name is rejected with feedback | Passed (both viewports) |
| `recent-history.spec.mjs` | render caps at 50 entries | Passed (both viewports) |
| `recent-history.spec.mjs` | entries without a valid id are dropped | Passed (both viewports) |
| `recent-history.spec.mjs` | clearing empties storage | Passed (both viewports) |
| `playback-error.spec.mjs` | failing song URL surfaces a clear error, clears loading, audio stays paused, no unexpected runtime error | Passed (both viewports) |

## Recovery Findings

- Backup import atomicity was already correct in the source: `parsePlaylistBackup`
  throws on any validation error *before* any IndexedDB access, and all writes
  run inside a single `readwrite` transaction. The new tests prove this
  behavior rather than fixing it; no production code change was needed for CP-2.

## Known Limits

- Recent-history dedupe-on-play and the play-driven `recordRecentPlay` path are
  triggered by a real `audio` `play` event and a module-private function, so
  the browser tests cover the deterministic read/render invariants (50-item cap,
  invalid-entry drop, clear) rather than record-time dedupe. Record-time dedupe
  remains covered by source/static checks; promoting it needs real-media
  playback automation, deferred with the device-level gates.
- User-playlist reorder/move is exercised only through source checks; the CRUD
  browser test covers create/delete/persist. Reorder browser coverage can be
  added later without changing the storage contract.
- Chromium device emulation still does not prove real Android/iOS background
  audio or power-management behavior; that remains a later device-level gate.
- No push or deployment was performed in this task.
