# Verification - API Key and Base-URL Configuration

## Environment

- Date: 2026-07-22
- Browser projects: desktop Chromium `1280x800`, mobile Chromium `390x844`
- Network policy: all ChKSz calls mocked at the browser boundary; no live API
  calls and no real credentials

## Evidence

### Reproducible environment

- `npm ci` -> exit 0; 77 packages installed, 78 audited, 0 vulnerabilities.
- `npx playwright install chromium` -> exit 0.

### Focused regression

- `npm test` -> 10 passed, 0 failed.
- `python tests/verify_features.py` -> `stability checks: passed`.
- `python scripts/check_module_syntax.py` -> `module syntax: passed`.
- `node --check sw.js` -> exit 0.
- `npx playwright test tests/e2e/api-config.spec.mjs tests/e2e/playback-error.spec.mjs --workers=1`
  -> 16 passed across desktop and mobile.

The focused browser run proves saved custom base/key transport, reserved key
character encoding, HTTP and JSON auth responses, remote-playlist auth
feedback, invalid-base atomic rejection, key-free reset, and playback recovery
stopping without skipping the next queued song.

### Complete quality gate

- `npm run verify` -> exit 0, all eight gate layers completed:
  - committed Tailwind CSS rebuilt without drift;
  - 10 unit tests passed;
  - main-module and Service Worker syntax passed;
  - static feature contracts passed;
  - dependency audit reported 0 vulnerabilities;
  - Playwright reported 43 passed and 1 intentional skip;
  - Git whitespace check passed.
- The one skip is the mobile duplicate of the offline Service Worker contract;
  `tests/e2e/app-shell.spec.mjs` explicitly runs that contract once in the
  desktop Chromium context.

### Visual and secret review

- Playwright CLI inspected the settings modal at desktop `1280x800` and mobile
  `390x844`. The API controls fit without overlap; the mobile status was changed
  to a full-width wrapping row after the first screenshot exposed truncation.
- Playwright CLI console check: 0 errors and 0 warnings.
- Screenshots are retained below `output/playwright/api-ui/` (ignored by Git).
- `rg -n "apikey|cp_api_key|cp_api_base" . --hidden -g "!node_modules/**" -g "!output/**" -g "!.git/**"`
  found only expected runtime storage access, parameter construction, test
  assertions, and documentation. No credential value is present.
- `git diff --check` -> exit 0.
- Local feature commit: `83d381c feat: add user-configurable ChKSz API key`.

## Quality Matrix

| Requirement | Evidence | Status |
| --- | --- | --- |
| Settings persistence and default base | Browser save/reset tests in both viewports | Passed |
| Four endpoints use the shared builder | Static feature-contract check | Passed |
| Auth feedback and no playback skip | Unit plus browser recovery tests | Passed |
| No fixed API key | Feature check plus repository scan | Passed |
| Release readiness | `npm run verify` and `git diff --check` | Passed |
