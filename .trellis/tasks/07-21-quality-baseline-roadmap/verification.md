# Verification - Quality Baseline and Roadmap

## Clean Dependency Install

- `npm ci`: passed; 77 packages installed from `package-lock.json` and npm
  reported 0 vulnerabilities.
- `npx playwright install chromium`: passed; the pinned Chromium runtime is
  available for local browser regression.

## Unified Gate

Command: `npm run verify`

Result on 2026-07-21: passed all eight layers in 17.7 seconds.

1. Tailwind CSS build passed and did not change committed `css/tailwind.css`.
2. Node unit tests passed: 9 passed, 0 failed, 0 skipped.
3. Extracted main-module syntax passed.
4. `sw.js` syntax passed.
5. Static feature contracts passed; build badge `v32`, 10 core assets.
6. `npm audit --audit-level=high` reported 0 vulnerabilities.
7. Playwright regression passed: 5 passed, 0 failed, 1 intentional skip.
8. `git diff --check` passed; Git emitted only local LF/CRLF conversion
   notices and no whitespace errors.

## Browser Evidence

| Project / viewport | Evidence | Result |
| --- | --- | --- |
| desktop-chromium / 1280 x 800 | shell startup with no unexpected page/console errors | Passed |
| desktop-chromium / 1280 x 800 | mocked service failure, retained query/sidebar, accessible retry, successful result | Passed |
| mobile-chromium / 390 x 844 | shell startup with no unexpected page/console errors | Passed |
| mobile-chromium / 390 x 844 | mocked service failure, retained query/sheet, accessible retry, successful result | Passed |
| desktop-chromium / 1280 x 800 | active Service Worker, online cache fill, offline reload | Passed |
| mobile-chromium / 390 x 844 | duplicate offline-shell case | Intentionally skipped; same Service Worker contract already runs once |

## Known Limits

- GitHub Actions was updated but cannot be observed until a future push; no
  push or deployment was performed in this task.
- Chromium device emulation does not prove real Android/iOS background audio
  behavior or browser power-management policy.
- Queue, user-playlist, recent-history, backup-import, playback-media-error,
  and old-cache update paths remain lower-strength rows in `research.md` and
  are assigned to later Goal phases rather than being reported as complete.
- The Tailwind build reports an outdated `caniuse-lite` data notice. It does
  not fail the build; dependency metadata refresh can be handled separately
  without mixing it into this quality-baseline change.
