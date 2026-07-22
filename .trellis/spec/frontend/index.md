# Frontend Development Guidelines

## Maintained Specifications

| Guide | Scope | Status |
| --- | --- | --- |
| [Quality Guidelines](./quality-guidelines.md) | Exact Pages artifact, release/rollback gate, browser regression, storage resilience, main app module loading, responsive accessibility, PWA install/update checks, deterministic media lifecycle, playback metadata, and API configuration | Maintained |

## Pre-Development Checklist

- Read `quality-guidelines.md` before changing playback metadata, external API
  behavior, browser storage, Service Worker logic, generated CSS, tests, or the
  Pages workflow.
- Search the current implementation and archived task evidence before adding a
  second helper, constant, cache rule, or test-only network path.
- Read the responsive accessibility contract before changing dialogs, drawers,
  tabs, player controls, dynamic song rows, or mobile control geometry.
- Read the main application module contract before moving runtime code, changing
  script entries, Tailwind scan paths, syntax checks, or precached JS assets.
- Keep live third-party availability outside deterministic pass/fail tests.

## Quality Check

- Run `npm run verify` after the final code change and before committing.
- Confirm browser tests cover both configured viewports when shared desktop
  and mobile behavior changes.
- Update the Service Worker cache version when a precached production asset
  changes; test-only files and documentation do not require a cache bump.
- Record any remaining manual-only or missing evidence in the active task's
  quality matrix instead of implying broader coverage than the tests prove.
