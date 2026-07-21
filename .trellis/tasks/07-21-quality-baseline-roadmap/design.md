# Design - Quality Baseline and Roadmap

## Verification Layers

The quality gate uses several layers because no single check proves the whole
static PWA works:

1. Build: generate the committed Tailwind CSS from its source.
2. Unit: test pure normalization, retry, playback, and timing logic.
3. Syntax: parse the module script extracted from `index.html` and `sw.js`.
4. Contract: retain source/config/deployment invariants that are cheap to
   inspect statically.
5. Browser: run the actual page in Chromium with deterministic network routes,
   real IndexedDB/localStorage, and a real Service Worker.

`npm run verify` owns ordering and failure propagation. Browser output lives
under `output/playwright/` so temporary traces and screenshots do not pollute
the repository root.

## Browser Projects

- `desktop-chromium`: 1280 x 800 viewport.
- `mobile-chromium`: 390 x 844 viewport with touch/mobile context.

The tests serve the repository over HTTP. Third-party API calls are intercepted
inside each browser context. Tests can sequence failures and successes without
depending on `api.chksz.top` or changing product code.

Search tests interact only through visible controls and accessible roles:

```
open search -> submit query -> mocked failures exhaust retry wrapper
-> recovery status + retry button -> mocked success -> result visible
```

The test must assert that the original query remains in the input and that the
desktop sidebar or mobile bottom sheet stays open throughout recovery.

## Service Worker Test

The offline-shell case uses a dedicated browser context. It loads the page,
waits for an active Service Worker controller, reloads once online to ensure
the current shell is cached, switches the context offline, then reloads and
asserts the application shell is usable. It does not claim that streaming or
search works offline.

## CI Integration

A quality job checks out the repository, installs dependencies with `npm ci`,
installs the Chromium browser required by Playwright, and runs `npm run verify`.
The Pages deploy job declares `needs: quality`. The deployment artifact remains
the existing explicit allowlist.

## Compatibility and Rollback

- Product data formats, API contracts, IndexedDB schema, and Service Worker
  runtime behavior do not change in this task.
- Browser tests use external mocks only; no test-only branch is added to the
  production application.
- Rollback consists of removing the Playwright files/scripts and the workflow
  dependency; existing deployment files remain unchanged.

## Trade-offs

- Chromium is the first deterministic CI browser to control runtime and install
  cost. Mobile WebKit/device testing remains in the release matrix for later
  phases.
- Large-file/module migration is deferred until browser coverage can protect
  the behaviors that migration might break.
