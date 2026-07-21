# Implementation Plan - API Key and Base-URL Configuration

1. [x] Review the inherited implementation against the no-secret and default
   `.top` constraints.
2. [x] Centralize all four ChKSz endpoint URLs and normalize HTTP/body auth
   failures before they reach feature-specific UI.
3. [x] Add settings save, validation, reset, and truthful local-storage/network
   transport copy.
4. [x] Cover desktop and mobile settings, search auth, playback stop behavior,
   remote-playlist auth, invalid input, and key-free reset with routed browser
   tests.
5. [x] Update the Service Worker cache revision, README, feature contracts, and
   frontend executable specification.
6. [x] Run the complete quality gate and secret-pattern scan; record exact
   evidence in `verification.md`.
7. [x] Commit locally, archive the task, and record the Trellis journal without
   pushing or deploying.

## Rollback

Revert the local feature commit. The storage keys are additive and optional;
older code ignores them, so no data migration or destructive rollback is
required.
