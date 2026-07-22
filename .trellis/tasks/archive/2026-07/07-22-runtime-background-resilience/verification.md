# Verification - Runtime and Background Resilience

## Environment

- Date: 2026-07-22
- Full browser projects: desktop Chromium `1280x800`, mobile Chromium
  `390x844`, narrow mobile `355x800`, and wide foldable `440x707`
- Playwright server: project-owned `http://127.0.0.1:4175`
- Network policy: ChKSz behavior mocked only at the browser boundary; generated
  fake keys only; no live API, push, deployment, or real external resource write

## Focused evidence

- `npm test` -> 11 passed, 0 failed.
- `python tests/verify_features.py` -> `stability checks: passed`.
- `python scripts/check_module_syntax.py` -> `module syntax: passed`.
- `node --check sw.js` -> exit 0.
- `PW_PORT=4175 npx playwright test tests/e2e/runtime-background-resilience.spec.mjs --workers=1`
  -> 18 passed across desktop and mobile.
- `PW_PORT=4175 npx playwright test tests/e2e/playback-error.spec.mjs tests/e2e/runtime-background-resilience.spec.mjs tests/e2e/service-worker-key-cache.spec.mjs --workers=1`
  -> the earlier focused boundary set passed 16/16 before the final transition
  cases were added; the complete gate below covers the final 18-case runtime set.

The focused regressions observe a real `HTMLAudioElement` boundary and prove:

- playback failure pauses the actual main Audio instance;
- pending song B cannot receive song A's time/duration, while system play and
  `ended` remain owned by committed song A;
- source replacement plus autoplay rejection synchronizes paused state and can
  recover on the next system play;
- final-item removal and explicit clear unload audio, increment `load()` calls,
  clear Media Session state, and invalidate a captured play handler;
- finite seeks clamp, explicitly invalid seeks perform no assignment or position
  publication, and Media Session position state remains valid;
- paused/hidden animation settles, visible resume owns one loop, repeated
  visibility events do not duplicate it, and paused resize redraws one frame;
- same-origin generated-key requests neither read nor write CacheStorage.

## Complete quality gate

- `PW_PORT=4175 npm run verify` -> exit 0; all eight layers completed:
  - committed Tailwind CSS rebuilt with no freshness drift;
  - 11 unit tests passed;
  - main module and Service Worker syntax passed;
  - static feature contracts passed;
  - dependency audit reported 0 vulnerabilities;
  - Playwright ran 102 tests: 100 passed, 2 intentional skips;
  - Git whitespace check passed.
- The skips are existing matrix scoping: desktop skips the mobile-only
  cover/lyrics toggle, and mobile skips the duplicate offline-shell contract.
- Final generated-secret scan for a fixed `apikey` assignment found no matches.
- Final `git diff --check` exited 0. Git printed only the repository's existing
  LF-to-CRLF checkout warnings.

## Quality matrix

| Requirement | Evidence | Status |
| --- | --- | --- |
| Committed media owns persistence and lifecycle events | Pending/pagehide, resume, ended, and autoplay browser regressions | Passed |
| Empty queue releases media/system identity | Final removal and real clear-button browser regressions | Passed |
| Media Session seek and position are bounded | Unit helper plus browser handler/assignment probes | Passed |
| Boot readiness follows restored state and handlers | Reloaded IndexedDB queue plus explicit-ready browser regression | Passed |
| Paused/hidden visuals do no recurring work | RAF/WebGL request, cancel, pending, and resize probes | Passed |
| Runtime API keys never enter app caches | Active-Worker same-origin cache read/write regression | Passed |
| Existing product flows remain intact | Complete 102-test four-viewport browser matrix | Passed |

## Residual manual evidence

- Huawei Pura X physical background playback, lock-screen controls, battery
  behavior, TalkBack, and remote GitHub Pages remain device/network-only checks.
- Automated Media Session tests prove handler and state contracts, not OEM power
  management behavior.
- The gate prints a non-blocking `caniuse-lite is outdated` maintenance warning;
  dependency audit remains at 0 vulnerabilities.
