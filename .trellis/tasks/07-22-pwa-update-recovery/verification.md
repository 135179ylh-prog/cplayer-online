# Verification - PWA Update Recovery

## Environment

- Date: 2026-07-22
- Browser projects: desktop Chromium `1280x800`, mobile Chromium `390x844`
- Worker policy: real current `sw.js`; test-only old Worker served at root scope
- External API policy: no live third-party calls

## Evidence

### Focused syntax and contract checks

- `node --check tests/e2e/server.mjs` -> exit 0.
- `node --check tests/e2e/fixtures/sw-old.js` -> exit 0.
- `node --check tests/e2e/service-worker-update.spec.mjs` -> exit 0.
- `python scripts/check_module_syntax.py` -> `module syntax: passed`.
- `node --check sw.js` -> exit 0.
- `python tests/verify_features.py` -> `stability checks: passed`, 10 core
  assets, build badge `v32`.

### Old-to-current Worker regression

Command:

`npx playwright test tests/e2e/service-worker-update.spec.mjs --workers=1`

Final result: 4 passed across desktop and mobile Chromium. The run proves:

- the old fixture controls the root scope before app startup;
- opening the real app replaces it with the real `/sw.js`;
- the accessible update prompt appears and can be dismissed without reload;
- cache `cplayer5-v54-pwa-update-recovery` has at least all 10 core assets;
- `cplayer5-test-old` disappears via a condition wait;
- `unrelated-test-cache` remains;
- clicking the real refresh command while offline reloads the cached shell;
- `current_queue`, recent history, and playback session survive.

The initial regression failed consistently on desktop and mobile because
`clients.claim()` ran outside the activation cleanup Promise. It is now the
last operation in the same `event.waitUntil` chain. Chromium can expose a short
cache-list visibility delay around `controllerchange`, so the final test polls
the old-cache absence condition instead of using a fixed delay.

### Visual inspection

Playwright CLI activated the old fixture, opened the real app, and inspected the
actual update notification at:

- desktop `1280x800`:
  `output/playwright/pwa-update/.playwright-cli/page-2026-07-21T16-54-36-499Z.png`;
- mobile `390x844`:
  `output/playwright/pwa-update/.playwright-cli/page-2026-07-21T16-55-53-004Z.png`.

Both show readable status/copy, 44px controls, and no overlap with the player.
The CLI console check reported 0 errors and 0 warnings on the app page.

### Complete release gate

After moving update registration behind awaited queue restore, the focused
startup/update run reported 7 passed and 1 intentional skip. The update prompt
test now asserts the seeded queue synchronously when the prompt first appears.

Final `npm run verify` -> exit 0 in 94.1 seconds. All eight layers completed:

1. committed Tailwind CSS rebuilt without drift;
2. 10 unit tests passed;
3. main-module syntax passed;
4. Service Worker syntax passed;
5. static feature contracts passed;
6. dependency audit reported 0 vulnerabilities;
7. Playwright reported 47 passed and 1 intentional skip across `1280x800` and
   `390x844`;
8. Git whitespace check passed.

The one skip is the existing mobile duplicate of the offline-shell-only
Service Worker test. The new full update path runs and passes in both projects.

## Quality Matrix

| Requirement | Evidence | Status |
| --- | --- | --- |
| First-install/update distinction | Browser lifecycle assertions | Passed |
| Accessible refresh/dismiss prompt | Desktop/mobile browser and visual checks | Passed |
| Queue/playback flush before reload | Browser storage round trip and source contract | Passed |
| Cache cleanup and unrelated-cache preservation | Real Cache Storage assertions | Passed |
| Offline app shell after upgrade | Old-to-current Worker offline reload | Passed |
| IndexedDB/localStorage survival | Post-upgrade browser reads | Passed |
| Release readiness | `npm run verify`, syntax, whitespace | Passed |

## Known Limit

Chromium emulation does not prove OS-specific PWA update scheduling or real
Android/iOS background-audio policy. No push, deployment, or production cache
observation was performed.
