# Core-Path Reliability

## Goal

Phase 2 of the productization goal: turn the low-strength rows of the quality
baseline evidence matrix into deterministic browser evidence, and harden
recovery for the two P0 data-loss paths. Prove that queue, user playlists,
recent history, backup restore, and playback error handling survive real
browser storage, reload, and injected failures without losing user data.

## Background

- Phase 1 established one quality gate (`npm run verify`) and deterministic
  browser tests for startup, search failure/retry, and offline shell reload.
- The evidence matrix (`research.md` of the quality-baseline task) flagged
  five flows as Low strength with no browser round-trip proof:
  - Queue add/remove/save/reload (P0)
  - Backup valid import + invalid atomic rollback (P0)
  - User-playlist CRUD/order (P1)
  - Recent-history dedupe/limit (P1)
  - Playback media-error / bounded skip / progress persistence (P1)
- All persistence uses browser IndexedDB/localStorage; the external ChKSz API
  boundary must be mocked so tests never depend on upstream availability.

## Requirements

### CP-1: Queue round-trip proof (P0)

Add browser tests that add tracks to the queue, remove a track, reload the
page, and assert the queue is restored exactly (order and contents) from
browser storage. Cover both an empty-start and a populated-restore case.

### CP-2: Backup atomic restore (P0)

Add browser tests proving that importing a valid backup replaces state as
expected, and that importing an invalid/corrupt backup fails atomically:
existing playlists, queue, and history must be unchanged after a rejected
import, with clear user-facing error feedback. If the current code cannot
guarantee atomicity, fix it so a failed import cannot partially overwrite data.

### CP-3: User-playlist CRUD and order (P1)

Add browser tests for creating a playlist, adding songs, reordering, removing
a song, deleting a playlist, and reloading to confirm persistence.

### CP-4: Recent-history dedupe and limit (P1)

Add a browser test proving recent history de-duplicates repeated plays and
enforces its maximum length, and that the order reflects most-recent-first.

### CP-5: Playback error recovery (P1)

Add a browser test that injects a failing song-URL response and asserts the
app surfaces a clear error, does not get stuck, and can advance/retry without
an unhandled runtime error. Use mocked network only.

### CP-6: Contract and matrix update

Update the evidence matrix and the frontend quality spec to reflect the new
automated rows, and record any recovery fixes made for CP-2. Every new browser
test must run inside `npm run verify`.

## Acceptance Criteria

- [x] Queue round-trip browser test proves add/remove/reload restore (P0).
- [x] Backup import test proves valid replace and invalid atomic rollback with
      no data loss and clear feedback (P0); code was already atomic (import runs
      one readwrite transaction after full pre-parse validation), verified by
      test rather than changed.
- [x] User-playlist CRUD/order browser test proves persistence across reload.
- [x] Recent-history browser test proves dedupe, limit, and ordering (read/
      render path; play-driven recording remains a device-level check).
- [x] Playback error test proves clear failure feedback and no stuck/unhandled
      state under a mocked failing song URL.
- [x] All new tests are deterministic (mock the ChKSz boundary) and run in
      `npm run verify`; the gate stays green from a clean `npm ci`.
- [ ] Evidence matrix and frontend quality spec updated; working tree has no
      uncommitted task code at finish.

## Out of Scope

- Migrating to a build framework, TypeScript, or component rewrite.
- Real-device background-audio behavior (later device-level release gate).
- Old-to-new Service Worker cache upgrade proof (owned by Phase 3).
- Pushing or deploying without separate user confirmation.
