# Implementation - Quality Baseline and Roadmap

1. Capture the current test, workflow, PWA, and storage evidence in
   `research.md`; create the eight-flow coverage matrix and prioritize gaps.
2. Add a pinned Playwright test dependency, configuration, artifact location,
   and deterministic API mock helpers.
3. Add desktop/mobile startup and search-recovery browser tests.
4. Add a Service Worker offline-shell browser test.
5. Add named npm validation scripts and the single `npm run verify` entry.
6. Add a GitHub Actions quality job and make Pages deployment depend on it.
7. Update `.trellis/spec/frontend/quality-guidelines.md` and README commands.
8. Run all validation layers, inspect browser artifacts, update
   `verification.md`, review the requirements one by one, and commit locally.

## Validation Commands

- `npm ci`
- `npx playwright install chromium`
- `npm run verify`
- `git diff --check`
- `git status --short`

## Risky Files and Rollback Points

- `.github/workflows/pages.yml`: a bad dependency can block deployment; keep
  the existing artifact preparation unchanged and validate YAML structure.
- Browser offline tests can be timing-sensitive; wait for explicit Service
  Worker controller state rather than fixed sleeps.
- `package-lock.json` must stay synchronized with `package.json` and use a
  pinned Playwright version.
- Generated `css/tailwind.css` must not acquire unrelated formatting churn.
