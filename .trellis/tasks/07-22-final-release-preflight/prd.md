# Final release preflight

## Goal

Make the locally verified site identical to the GitHub Pages upload, close the
repository-check blind spot found during the storage milestone, and produce a
database-v4-safe release and rollback procedure. Do not push or deploy.

## Background

- Playwright currently serves the repository root, while Pages assembles a
  smaller allowlisted directory inside the workflow. A missing copy entry can
  pass every local browser test and fail online.
- The old release notes describe an IndexedDB-v3 code line. The current player
  migrated `CPlayer5DB` to version 4; deploying a v3 rollback target would raise
  `VersionError` and temporarily make queue/playlist data unreadable.
- `git diff --check` ignores untracked task/test files. This allowed malformed
  new documents to pass the full gate until the staged diff was checked.
- README says Node 18, the quality script uses newer Node APIs, and CI uses Node
  22. One supported baseline is required.

## Requirements

- Define the Pages file/directory allowlist once in a cross-platform Node build
  script. It must replace the workflow's shell copy block, rebuild only the
  repository-owned `output/pages` directory, and reject an unsafe output path.
- The release quality gate must build that directory before Playwright and run
  the complete browser suite against it. The test server may expose its
  controlled API and old-Worker fixture, but all normal static files must come
  from the selected web root.
- Browser coverage must prove the exact artifact reaches app-ready on desktop
  and mobile, serves required runtime assets, installs the real Worker, reloads
  offline, and returns 404 for repository-only paths such as `.trellis`, tests,
  scripts, package metadata, and workflow files.
- The Pages workflow must upload the already tested `output/pages` directory
  from the quality job. The deploy job must not perform a second checkout or
  independently reconstruct the site.
- Repository checks must cover unstaged and staged diffs plus untracked text
  files. Generated `output/pages` remains ignored.
- Provide a local rollback-target command that extracts `CPlayer5DB` schema
  versions from the current tree and a Git ref. It must reject any target below
  the current version and explain why; it must not mutate Git history.
- Align `package.json`, README, and CI on Node.js 22 or newer.
- Refresh release notes and device validation records with the current cache,
  DB schema, test matrix, release steps, data compatibility, and external/manual
  limits. A safe rollback is a new forward commit based on v4-compatible code,
  never deployment of a v3 snapshot.
- Keep all checks deterministic. Do not use a real API key, live ChKSz request,
  production branch, push, deployment, tag, or remote workflow run.

## Acceptance Criteria

- [x] `npm run build:pages` creates only the intended deployable runtime tree,
  prints an auditable file/byte count, and refuses an unsafe destination.
- [x] `npm run verify` runs the full browser suite from `output/pages` and all
  quality layers pass.
- [x] Desktop and mobile artifact tests prove app-ready, required assets,
  Service Worker/offline shell behavior, and 404s for repository-only files.
- [x] GitHub Pages uploads the exact directory produced and tested in the
  quality job; no duplicate shell copy allowlist remains.
- [x] Staged and untracked whitespace regressions are caught by the repository
  gate; the final task files pass it.
- [x] `npm run check:rollback -- <safe-ref>` passes for a DB-v4 target and rejects
  a known DB-v3 target without changing the worktree.
- [x] Node 22+ is declared consistently in package metadata, README, and CI.
- [x] Current release notes identify DB v4 and the current Worker cache, contain
  safe publish/rollback steps, and do not repeat the obsolete "no migration"
  claim.
- [x] Unit, syntax, static contracts, dependency audit, full browser regression,
  generated CSS, repository checks, and focused artifact checks pass.
- [ ] Product changes are committed locally, the task is archived, the journal
  is recorded, and the final worktree is clean. Nothing is pushed or deployed.

## Out Of Scope

- Executing the Huawei Pura X/TalkBack checklist.
- Pushing `main`, deploying Pages, tagging, or observing remote Actions.
- Refactoring player business logic or changing the database schema beyond v4.
- Treating the fixed `v32` UI badge, Worker cache revision, and DB schema as one
  shared version number; their meanings remain distinct.
