# Implementation - PWA Update Recovery

1. Add the hidden update notification with desktop/mobile-safe dimensions,
   accessible status, refresh, and dismiss controls.
2. Extract Service Worker registration into one setup function that binds
   `controllerchange` first and distinguishes first install from replacement.
3. Reuse queue and playback persistence owners in an awaited update-reload
   command; prevent repeated activation.
4. Advance the Service Worker cache name and extend static contracts.
5. Add the Node static Playwright server and root-scope old Worker fixture.
6. Add a browser upgrade test that asserts controller replacement, cache
   cleanup/preservation, update UI, offline reload, and IndexedDB/localStorage
   survival. Keep the one browser-engine contract desktop-only.
7. Add desktop/mobile first-install and update-notification layout evidence.
8. Update README, frontend executable spec, task verification, and run the
   complete release gate before local commit and archive.

## Validation Commands

- `node --check tests/e2e/server.mjs`
- `node --check tests/e2e/fixtures/sw-old.js`
- `npx playwright test tests/e2e/service-worker-update.spec.mjs --workers=1`
- `npm run verify`
- `git diff --check`
- `git status --short`

## Risk Points

- Binding `controllerchange` after registration can miss a fast `skipWaiting`
  transition; bind first.
- First installation also fires `controllerchange`; do not mislabel it as an
  update.
- A fixture outside root needs an explicit Service-Worker-Allowed response
  header; keep that behavior in the test server only.
- Existing local servers on port 4173 can bypass the new test server through
  Playwright's reuse setting; stop stale servers before the upgrade test.
- Do not assert a fixed cache revision in the browser test when it can be read
  from the production Worker source.
