# Implementation Plan - Optional accounts and playlist cloud sync

1. [x] Add the pinned Supabase browser dependency, reproducible vendor-copy
   script, empty public config owner, and artifact/Service Worker ownership.
2. [x] Add `js/cloud-sync.js` with configuration, auth adapter, remote playlist
   validation, RPC error normalization, and pure merge decisions; cover it with
   Node unit tests.
3. [x] Upgrade IndexedDB to v5 and add the owner-scoped `cloud_outbox`. Make
   playlist save/import/delete plus outbox updates atomic while preserving v4
   data and existing local behavior.
4. [x] Add the accessible settings account card and wire sign-up, sign-in,
   sign-out, recovery, password update, manual sync, conflict choices, and
   account deletion.
5. [x] Implement the single-flight local-first sync coordinator, online retry,
   per-owner isolation, merge/pull/push/delete handling, and local retention after
   account deletion.
6. [x] Add the Supabase SQL migration with RLS, optimistic-version RPCs, and the
   restricted self-delete RPC; add executable static/schema checks.
7. [x] Extend deterministic desktop/mobile browser coverage and Service Worker
   cache-boundary coverage. Mock only HTTP boundaries and use generated users,
   project URLs, publishable keys, and tokens.
8. [x] Update the frontend quality contract, README setup/privacy/rollback notes,
   task acceptance mapping, and verification evidence.
9. [x] Run focused tests, then `npm run verify`; review the complete diff and
   commit/archive only when every locally testable gate passes. Do not push,
   deploy, or create a real Supabase project.

## Risk Points

- `js/app.js`: playlist persistence and boot ordering are shared critical paths.
- IndexedDB v5: schema version is forward-only; rollback documentation and guard
  tests must change in the same commit.
- `sw.js`: authenticated responses must bypass every cache branch.
- Account deletion: server success must precede local owner detachment.
- Conflict handling: resolving one playlist must not clear another playlist's
  pending operation.

## Validation Commands

```powershell
npm run test:unit
npm run check:module
npm run check:sw
npm run check:features
npx playwright test tests/e2e/account-cloud-sync.spec.mjs
npx playwright test tests/e2e/service-worker-key-cache.spec.mjs
npm run verify
```
