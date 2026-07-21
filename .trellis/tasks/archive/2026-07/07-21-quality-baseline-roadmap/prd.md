# Quality Baseline and Roadmap

## Goal

Establish the first phase of the long-term productization goal: one repeatable
quality gate, deterministic browser coverage for the highest-risk user paths,
and an evidence-backed matrix that turns remaining gaps into ordered work.

## Background

- The app already contains queue persistence, user playlists, recent history,
  backup import/export, playback recovery, search recovery, and a Service
  Worker, but evidence is spread across archived task notes and manual runs.
- `npm test` currently covers nine pure utility cases in
  `tests/core-utils.test.mjs`.
- `tests/verify_features.py` protects important source-level invariants but
  cannot prove that the rendered UI or browser storage flows work.
- `.github/workflows/pages.yml` deploys the committed static files without
  running a build or quality gate first.
- The application still has most runtime code in `index.html`; a large build
  migration before behavioral coverage would make regressions hard to detect.

## Requirements

### QB-1: One local quality gate

Provide one documented command that runs the CSS build, unit tests, JavaScript
syntax checks, feature-contract checks, and browser regression suite. A failed
step must stop the command with a non-zero exit code and a readable label.

### QB-2: Deterministic browser baseline

Add browser tests that do not depend on the availability or data shape of the
live third-party API. The initial suite must cover desktop and mobile startup,
search failure and retry recovery, and Service Worker offline shell reload.
Browser console/page errors must fail startup tests except for errors that a
test deliberately injects and asserts.

### QB-3: Core-flow evidence matrix

Record the current evidence for search, playback, queue, user playlists,
recent history, backup restore, offline shell, and update behavior. Each row
must distinguish automated browser evidence, unit/static evidence, manual-only
evidence, and missing evidence. Missing or weak rows become explicit follow-up
work for later Goal phases.

### QB-4: CI quality gate

Run the same quality command in GitHub Actions before Pages deployment can
publish. The workflow must use pinned major action versions, install locked npm
dependencies, and install only the browser required by the suite.

### QB-5: Stable project contracts

Update the frontend quality spec with the actual test layers, deterministic
network-mocking rule, Service Worker cache-version rule, and generated CSS
freshness rule discovered during this task.

## Acceptance Criteria

- [x] `npm run verify` is the single documented local release-check command.
- [x] The command passes from a clean checkout after `npm ci` and reports each
      validation layer clearly.
- [x] Desktop and mobile browser projects prove the app boots without
      unexpected runtime errors.
- [x] Desktop and mobile search tests prove failure feedback, retained query
      and panel state, retry, and successful result rendering.
- [x] A Service Worker test proves the app shell can reload after the browser
      context goes offline.
- [x] The quality matrix covers all eight Goal-critical flows and assigns each
      uncovered risk a severity and next phase.
- [x] Pages deployment depends on the quality job and cannot publish after a
      failing check.
- [x] Frontend quality guidance documents the resulting executable contracts.
- [x] Task verification records exact commands, counts, viewports, and known
      limitations; the working tree has no uncommitted task code.

## Out of Scope

- Migrating the application to Vite, TypeScript, or a component framework.
- Treating live third-party API availability as a pass/fail condition.
- Claiming real mobile background audio behavior from desktop browser
  automation; that remains a later device-level release check.
- Pushing or deploying to GitHub without separate user confirmation.
