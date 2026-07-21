# Implementation - API Key and Base-URL Configuration

1. Review the existing Claude changes and update the central request boundary
   for response-body auth codes, robust base normalization, default address
   display, and search auth recovery feedback.
2. Remove stale per-instance base-url synchronization if the centralized
   builder is the only request source.
3. Add deterministic browser tests for settings save, encoded key/query and
   custom base, 401 search feedback, and reset/no-key behavior in both viewport
   projects where shared UI applies.
4. Add feature-contract checks for localStorage ownership, all four builder
   call sites, no literal secret, and the Service Worker cache revision.
5. Build Tailwind CSS and run the complete `npm run verify` gate after `npm ci`.
6. Update the frontend quality spec and task verification, commit locally, and
   archive the task without pushing or deploying.

## Validation Commands

- `npm test`
- `npm run build:css`
- `npm run verify`
- `git diff --check`
- `git status --short`

## Risk Points

- The upstream can return auth failure as HTTP 401/403 or HTTP 200 with JSON
  `code: 401/403`; both must reach the same classifier.
- API key values must only be supplied by test fixtures at runtime and must not
  appear in screenshots, traces, source, or task documents.
- Static asset changes require a Service Worker cache-name bump and updated
  static verifier expectation.
