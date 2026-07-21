# Implementation Plan - PWA Update Recovery

1. [x] Recover the Phase-3 gap and inspect current Service Worker, storage,
   registration, offline-test, and release-contract evidence.
2. [x] Implement the update notification and safe user-controlled reload.
3. [x] Implement the test-only static server and old Worker fixture.
4. [x] Prove old-to-current activation, cache safety, offline reload, and data
   survival in Chromium.
5. [x] Inspect desktop/mobile rendered states and fix layout/accessibility gaps.
6. [x] Update executable specs and task records; run the complete gate.
7. [x] Commit locally, archive the task, and record the session without pushing
   or deploying.

## Rollback

Revert the local feature commit. No migration is needed because the task does
not alter user-data schemas; a subsequent cache revision can replace the
reverted Worker normally.
