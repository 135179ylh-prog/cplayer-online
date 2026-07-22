# Verification - Final release preflight

## Final local quality gate

Command:

```powershell
$env:PW_PORT='4201'; npm run verify
```

Result on 2026-07-23: all nine layers passed in 279.1 seconds. An earlier run
used a 120-second command-wrapper limit and was terminated during Playwright with
`EPIPE`; it contained no failed assertion. The longer rerun below completed.

1. Committed Tailwind CSS rebuilt without drift.
2. Unit tests: 25 passed, 0 failed, 0 skipped.
3. Main `js/app.js` syntax passed; 307,059 bytes.
4. Service Worker syntax passed.
5. Static feature/release contracts passed.
6. Dependency audit reported 0 vulnerabilities.
7. Pages artifact built: 24 files, 43,691,111 bytes.
8. Browser regression from that exact directory: 126 discovered, 124 passed,
   two intentional skips, zero failures.
9. Unstaged/staged/untracked repository checks passed; all inspected text
   snapshots passed and zero untracked files remained.

Browser viewports:

- Desktop Chromium: `1280x800`.
- Mobile Chromium: `390x844`.
- Narrow mobile Chromium: `355x800` (responsive/accessibility only).
- Wide foldable Chromium: `440x707` (responsive/accessibility only).

The skips remain scope-specific: desktop skips the mobile-only cover/lyrics
toggle; mobile skips the older duplicate offline-shell case. The new artifact
offline case runs and passes on both desktop and mobile.

## Focused artifact proof

```powershell
$env:PW_PORT='4194'
$env:PW_WEB_ROOT=(Resolve-Path 'output/pages').Path
npx playwright test tests/e2e/release-artifact.spec.mjs --workers=1
```

Result: 2/2 passed. The server printed the selected artifact root. Both projects
proved public runtime 200s, repository-private 404s, app-ready, current `/sw.js`
control, and offline reload.

## Clean install and scripts

- `npm ci`: 82 packages installed; 83 audited; 0 vulnerabilities.
- Syntax checks passed for the three new scripts, quality gate, Playwright
  config, test server, and artifact browser test.
- Unit tests passed 25/25, including regressions for linked output roots,
  parsed HTML/script boundaries, independent `srcdoc`, WHATWG JavaScript URLs,
  classic/async/module scheduling, sticky alias and DB-name invalidation, dynamic
  global writes, capability destructuring, runtime-generated code, class static
  blocks, `var`/global-property/function/closure semantics, parameters, nested
  deployed HTML/script paths, dual-mode residual `.js`, conflicting JS/MJS in
  every deployed directory, staged non-UTF-8 and type-change blobs, BOM, and
  legacy CR line endings.
- `npm run build:pages`: repeatably reported 24 files / 43,691,111 bytes.
- `npm run check:features`: passed the single allowlist owner, artifact-root,
  quality-upload, Node, repository, rollback, and documentation contracts.

## Repository-check red/green proof

An untracked `_repo-check-probe.md` ending with an extra blank line was created
temporarily. `npm run check:repo` failed with:

```text
_repo-check-probe.md: extra blank line at EOF
```

The probe was deleted through the editing tool. The same command then passed;
the probe is absent from Git status and is not part of the task.

## Rollback compatibility proof

Safe target:

```powershell
npm run check:rollback -- 2b26ac4
```

Passed: target commit `2b26ac4a37f01eac0a9f2031aa0db5be353add8c`, current
v4, target v4.

Unsafe target:

```powershell
npm run check:rollback -- 93dadf4
```

Expected rejection (exit 1): target v3 is below current v4 and requires a
forward revert retaining `DB_VERSION >= 4`. Git status was unchanged by both
read-only probes.

## Cross-layer evidence

| Boundary | Evidence |
| --- | --- |
| Source tree -> artifact | One Node allowlist; guarded output; exact file/byte count. |
| Artifact -> browser | Full suite used `PW_WEB_ROOT=output/pages`; public/private HTTP assertions. |
| Browser -> PWA | Real Worker install/update/offline/cache tests remained green. |
| Quality -> deploy | Workflow quality job uploads `output/pages`; deploy job only calls deploy-pages. |
| Current DB -> rollback ref | Read-only extractor aggregates every deployed HTML/JS/MJS path in both trees, accepts v4, and rejects v3. |
| New files -> repository gate | Red/green untracked EOF probe plus staged/unstaged Git checks. |

## Unexecuted evidence and residual risk

- The workflow source is verified, but it was not pushed and no remote Actions
  or Pages deployment ran.
- Huawei Pura X, Android background/lock screen, TalkBack, Bluetooth, power
  saving, and real safe-area checks remain unexecuted.
- Parallel audit found mobile landscape clipping, an opened-sidebar critical Axe
  violation, incomplete safe-area/reduced-motion behavior, a 43.7 MB artifact
  dominated by fonts, and incomplete user-library browser round trips. These are
  explicit next milestones, so the long-term Goal remains active.
- `caniuse-lite` still prints an update notice; audit remains 0 vulnerabilities.
- Runtime-created DOM scripts, handler attributes, and `srcdoc` remain outside the
  static extractor; introducing them requires a matching parser/test expansion.
- No live third-party API, real key, push, deploy, tag, or remote workflow was
  used.
