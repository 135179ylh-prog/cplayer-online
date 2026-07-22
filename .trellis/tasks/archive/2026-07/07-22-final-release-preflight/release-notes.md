# CPlayer 5 - Local release preflight

## Status

This is a locally verified release artifact, not a deployed release. The exact
GitHub Pages directory passes the automated gate, but the mobile-runtime and
user-library gaps listed below still need separate milestones. Nothing in this
task was pushed, tagged, deployed, or run against a real ChKSz credential.

Artifact implementation commit: `4bf4f2209727bdb6532df0d5ea6bbb68b0f4b414`.

## Verified release identity

| Item | Current value |
| --- | --- |
| UI build badge | `v32` |
| Service Worker cache | `cplayer5-v59-storage-resilience` |
| IndexedDB schema | `CPlayer5DB` v4 |
| Pages artifact | 24 files, 43,691,111 bytes |
| Node.js support | 22 or newer |
| Automated browser matrix | 126 cases: 124 passed, 2 intentional skips |
| Viewports | 1280x800, 390x844, 355x800, 440x707 |

The three version values have different meanings. The UI badge identifies the
existing product line, the Worker cache invalidates static resources, and the DB
version controls local-data compatibility. They are not expected to match.

## What changed in this preflight

- `npm run build:pages` is now the only owner of the Pages file allowlist.
- `npm run verify` has nine labelled layers and runs every browser case from
  `output/pages`, not from the larger repository.
- The GitHub Actions quality job uploads that already-tested directory; the
  deploy job only deploys it and cannot reconstruct a different site.
- Artifact browser tests prove required runtime files are present, repository
  internals return 404, the real Worker controls the page, and desktop/mobile
  can reload the shell offline.
- Repository checks cover unstaged, staged, and untracked non-ignored text, so a
  newly created malformed test/task file cannot hide from the final gate.
- `npm run check:rollback -- <git-ref>` parses every deployed HTML/JS/MJS path in
  the current and target trees without running it. It resolves nested script paths,
  includes inline handlers, normalized JavaScript URLs, independent `srcdoc` and
  static-block scopes, sticky cross-schedule aliases, and dual classic/module
  residual `.js` checks. Runtime-generated/imported code, global mutation APIs,
  escaped capabilities, unresolved timers, conflicting versions, and below-v4
  opens are rejected.
- Local documentation, package metadata, and CI now agree on Node.js 22+.

## User data compatibility

- The current application upgrades `CPlayer5DB` from v3 to v4 by adding the
  image-cache timestamp index. Queue, `user_pl_*` playlists, lyrics, images, and
  localStorage records remain in place.
- No backup format, API setting key, recent-history key, or playback-session
  version changed in this task.
- Do not clear site data during an update or rollback. Export playlist backup
  before any manual browser-data operation.

## Local release check

Run these commands from the project directory:

```powershell
node --version
npm ci
npx playwright install chromium
$env:PW_PORT='4196'
npm run verify
git status --short
```

Expected result: Node is 22+, all nine layers pass, the artifact reports 24
files, browser regression reports 124 passed and two intentional skips, and
`git status --short` is empty after the task commits/archives are complete.

## Remote release steps

These operations affect GitHub Pages and require explicit user approval:

1. Record the exact `main` commit intended for release and confirm the worktree
   is clean.
2. Complete the blocking automated milestones and the required device checks in
   `device-validation.md`.
3. Push `main`. The Actions quality job runs `npm run verify`, then uploads its
   own tested `output/pages` artifact. A failed quality job prevents deploy.
4. Confirm the workflow commit and Pages URL, then check the build badge, Worker
   controller, settings, local library, search failure feedback, and update flow.
5. Record the remote run URL, deployed commit, browser/device versions, and any
   deviation from the local artifact counts.

## Safe rollback

Never deploy an old snapshot that opens `CPlayer5DB` v3 after users may have v4
data. Never solve a rollback by clearing browser data or force-pushing history.

1. Inspect a proposed base ref without changing files:

   ```powershell
   npm run check:rollback -- <target-ref>
   ```

2. If it fails, make a new forward revert commit from current `main`. Restore the
   desired product behavior while retaining `DB_VERSION >= 4` and v4 open/
   `versionchange` compatibility.
3. Give the rollback Worker a new cache revision rather than reusing an old
   cache name. Keep the complete core-asset list.
4. Run `npm run verify` from a clean Node 22 install. Confirm queue, user
   playlists, recent history, backup import, old-Worker update, and offline reload.
5. Only after explicit approval, push the forward revert. Verify the remote
   workflow and Pages behavior without deleting site data.

Current local probes:

- `2b26ac4` opens DB v4 and passes the version preflight.
- `93dadf4` opens DB v3 and is rejected as unsafe.

## Known blockers and limits

- Mobile landscape (`844x390` and `740x360`) is not in the gate and currently
  clips core controls/content.
- Opening the desktop playlist/search sidebar exposes a critical Axe tablist
  violation that the existing closed-shell scan does not cover.
- Safe-area selectors do not yet cover the real mobile bottom controls, and
  reduced-motion still allows continuous visual animation.
- Four full local font files make the artifact about 43.7 MB; mobile transfer
  and large-playlist rendering need a dedicated performance milestone.
- User-playlist add/reorder/play, real recent-play writes, and export-then-import
  still need complete browser round trips.
- Huawei Pura X background/lock-screen/media controls, TalkBack, Bluetooth,
  power-saving behavior, and remote Pages deployment remain unexecuted.
- Local deterministic CI does not make live ChKSz availability a pass/fail
  signal. Search/audio still depend on that third-party service.
