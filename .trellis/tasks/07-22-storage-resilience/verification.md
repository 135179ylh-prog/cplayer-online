# Verification - Storage resilience

## Final quality gate

Command:

```powershell
$env:PW_PORT='4193'; npm run verify
```

Result: passed all 8 layers on 2026-07-22.

- CSS build: passed; generated CSS remained current.
- Unit tests: 11 passed, 0 failed, 0 skipped.
- Main module syntax: passed (`js/app.js`, 307059 bytes).
- Service Worker syntax: passed.
- Static feature contracts: passed.
- Dependency audit: 0 vulnerabilities.
- Browser regression: 124 discovered; 122 passed; 2 intentional skips.
- Git whitespace gate: passed; only repository LF/CRLF notices were printed.
- Fixed-value API-key scan across production HTML/JS/Worker files: no matches.

Browser viewports covered:

- Desktop Chromium: 1280x800.
- Mobile Chromium: 390x844.
- Narrow mobile Chromium: 355x800.
- Wide foldable Chromium: 440x707.

## Focused evidence

```powershell
$env:PW_PORT='4192'; npx playwright test tests/e2e/storage-resilience.spec.mjs tests/e2e/backup-restore.spec.mjs tests/e2e/playlist-crud.spec.mjs --workers=1
```

Result: 30/30 passed (15 desktop and 15 mobile); the storage subset is 18/18.
The suite proves:

- localStorage `SecurityError` keeps the player ready with degraded feedback;
- a real held v3 connection triggers v4 `blocked` without hanging startup;
- a real v5 open closes the v4 page as stale and prevents empty backup success;
- two loaded pages cannot overwrite a newer queue revision;
- a non-empty `playlist.js` adopts and advances the persisted revision on reload;
- normal pruning keeps 160 images and 12 remote lists while preserving queue and
  `user_pl_*` records byte-for-byte;
- one-shot quota failure prunes disposable caches and retries exactly once;
- persistent quota failure reports failure, writes no false record, and can
  recover on a later mutation;
- optional remote-playlist cache failure leaves the fetched playlist rendered.

```powershell
$env:PW_PORT='4183'; npx playwright test tests/e2e/service-worker-key-cache.spec.mjs --workers=1
$env:PW_PORT='4184'; npx playwright test tests/e2e/service-worker-update.spec.mjs --workers=1
```

Results: 6/6 and 4/4 passed. Controlled 200 responses proved keyed and key-free
dynamic music endpoints remain network-only, unrelated same-URL caches cannot
poison app reads, and the old Worker upgrades to v59 while preserving browser
data and offline reload.

Normal-path focused regression:

```powershell
$env:PW_PORT='4182'; npx playwright test tests/e2e/app-shell.spec.mjs tests/e2e/queue-roundtrip.spec.mjs tests/e2e/playlist-crud.spec.mjs --workers=1
```

Result: 15 passed and 1 intentional mobile offline-shell skip.

## Acceptance mapping

| Risk | Evidence |
| --- | --- |
| Storage denied at module start | `localStorage SecurityError...` browser case; app ready + degraded state + warning. |
| Upgrade blocked or connection stale | Real multi-page IndexedDB v3/v4/v5 cases; no synthetic production branch. |
| Legacy marker split-brain | Queue restore/cache-prune case and non-empty `playlist.js` reload case. |
| Multi-tab lost update | Queue revision conflict case compares the persisted winner byte-for-byte. |
| Shared quota exhausted | One-shot and persistent quota probes plus direct IndexedDB inspection. |
| Disposable caches crowd user data | Overflow seed/prune case proves exact caps and protected records. |
| Optional cache error misreported | Successful mocked playlist remains rendered with cache-only warning. |
| Dynamic API/unrelated cache pollution | Real Service Worker controlled-200 cache isolation cases. |

## Boundaries and residual risk

- Quota and SecurityError paths use browser-boundary probes because deterministic
  test runs cannot safely fill a real user's disk or change browser site policy.
- Multi-tab edits are not auto-merged. The stale writer is rejected and must
  refresh; silent overwrite is prevented.
- Database version 4 is a forward migration. Any future rollback must continue to
  open version 4 even if it does not use the image timestamp index.
- Physical-device private-mode quotas and OEM storage eviction remain manual-only
  evidence. No live third-party API or real credential was used.
- Nothing was pushed or deployed.
