# Implementation - Mobile landscape and accessibility hardening

1. Add responsive-only Playwright projects for `844x390` and `740x360`.
2. Extend responsive browser tests with explicit landscape geometry, opened
   playlist/search Axe scans, tablist child semantics, and deterministic
   safe-area variable injection.
3. Extend the runtime visual lifecycle test with reduced-motion-at-load and
   dynamic preference-switch coverage while verifying playback remains active.
4. Add compact landscape CSS and stable bottom/progress control IDs; keep header
   actions visible and force the mobile layout across the Tailwind breakpoint.
5. Isolate desktop tabs in their own tablist and leave queue clearing outside
   the tab keyboard model.
6. Add viewport-fit and shared safe-area variables wired to real mobile nodes.
7. Add the shared reduced-motion query, change listener, visual predicate gates,
   and CSS motion reduction.
8. Advance the Service Worker cache name for the precached HTML/module and update
   the static expectation without changing the IndexedDB schema.
9. Rebuild committed Tailwind CSS if markup utility extraction changes, then run
   focused responsive/runtime tests and inspect both landscape screenshots.
10. Run unit/static checks and the complete quality gate on a free port. Record
   commands, counts, viewport evidence, and residual real-device limits.
11. Update the responsive accessibility contract, commit locally, archive the
    task, and record the journal. Do not push or deploy.

## Risk and rollback points

- `index.html` combines inline CSS with later generated Tailwind CSS; landscape
  display and reduced-motion overrides require sufficient specificity and
  `!important` where utilities would otherwise win.
- `js/app.js` must stop only recurring visual loops. Do not globally replace or
  disable `requestAnimationFrame`.
- Safe-area tests override production custom properties, not browser internals.
- A focused regression failure blocks the full quality gate; repeated failures
  must be diagnosed before broadening the patch.
