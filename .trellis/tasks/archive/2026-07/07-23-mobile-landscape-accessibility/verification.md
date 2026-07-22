# Verification - Mobile landscape and accessibility hardening

## Final local quality gate

Command:

```powershell
$env:PW_PORT='4223'; npm run verify
```

Result on 2026-07-23: all nine layers passed in 273.5 seconds from the final
code/test/spec snapshot.

1. Committed Tailwind CSS rebuilt without drift.
2. Unit tests: 25 passed, 0 failed, 0 skipped.
3. Main module syntax passed; `js/app.js` is 308,436 bytes.
4. Service Worker syntax passed with cache
   `cplayer5-v60-mobile-landscape-accessibility`.
5. Static feature, responsive, motion, and PWA contracts passed.
6. Dependency audit reported 0 vulnerabilities.
7. Pages artifact built: 24 files, 43,695,486 bytes.
8. Browser regression from that exact artifact: 164 discovered, 152 passed,
   12 intentional viewport/scope skips, zero failures.
9. Repository checks passed: 14 worktree paths and 14 text snapshots inspected,
   zero whitespace/encoding failures.

Browser viewports:

- Desktop Chromium: `1280x800`.
- Mobile Chromium: `390x844`.
- Narrow mobile Chromium: `355x800` (responsive/accessibility only).
- Wide foldable Chromium: `440x707` (responsive/accessibility only).
- Wide landscape Chromium: `844x390` (responsive/accessibility only).
- Compact landscape Chromium: `740x360` (responsive/accessibility only).

The skips are deliberate: landscape geometry runs only in the two landscape
projects; the rotation case starts only in the standard mobile project; mobile
cover/lyrics and safe-area cases skip desktop; the duplicate mobile offline-shell
case remains skipped because the artifact offline path runs in both base projects.

## Focused browser evidence

| Command / scope | Result |
| --- | --- |
| Landscape geometry at `844x390` and `740x360` | 2/2 passed. |
| Open playlist/search panel Axe plus safe-area ownership across representative projects | 7 passed, 1 scope skip. |
| Full six-project responsive suite before review tightening | 54 passed, 6 scope skips. |
| Runtime background resilience after reduced-motion implementation | 22/22 passed. |
| Service Worker key isolation and old-to-v60 upgrade | 10/10 passed. |
| Post-review landscape, rotation, and safe-area focus | 6 passed, 3 scope skips. |
| Post-review reduced-motion desktop/mobile focus | 4/4 passed. |

All HTTP, media, API, storage, and animation boundaries were deterministic. No
live ChKSz request or real API key was used.

## Visual and failure evidence

Before the fix:

- `844x390` selected the desktop player and clipped the main play button below
  the viewport.
- `740x360` selected the mobile player but placed the 300px record at
  `y=-158.390625`.
- Opening the desktop drawer produced Axe `aria-required-children` because the
  queue-clear command was a direct child of the tablist.

After the fix, Playwright screenshots at both landscape sizes show the header,
record, title/artist/metadata, progress, all five primary controls, queue clear,
and music library action inside the viewport. Geometry assertions additionally
prove non-zero visibility, viewport containment, ordered metadata/control rows,
and non-overlapping left/right columns. Local ignored screenshots are under
`output/playwright/landscape-{before,after}-*.png`.

The first broad pre-review quality run reached 151 browser passes and seven
scope skips, then correctly failed layer 9 on three historical trailing-space
lines in the now-modified HTML plus an extra task-document newline. Those lines
were removed. Independent review then found four P2 gaps: JS/CSS layout-query
drift, incomplete landscape geometry assertions, missing sheet side safe-area
assertions, and hidden-mobile selectors in the desktop motion test. All four
were fixed and covered before the successful final gate.

## Requirement evidence

| Requirement | Authoritative evidence | Status |
| --- | --- | --- |
| Compact landscape selection and complete geometry | Two dedicated projects, non-zero rect/bounds/order assertions, screenshots | Passed |
| Rotation preserves open mobile sheet | `390x844` to `844x390` state regression using the shared media query | Passed |
| Open drawer accessibility | Playlist and search Axe scans in all six projects; direct tablist-child assertion | Passed |
| Safe-area ownership | `viewport-fit=cover` plus injected top/right/bottom/left variables on real controls/sheet | Passed |
| Reduced motion without audio pause | Real RAF/WebGL probes, visible desktop/mobile CSS nodes, mocked Audio/Media Session | Passed |
| Installed PWA receives changed assets | v60 cache bump plus old-Worker upgrade/offline regression | Passed |
| Existing product paths remain stable | 164-case artifact browser gate and 25 unit tests | Passed |

## Residual manual evidence

- Chromium cannot emulate a physical display cutout. The production CSS-variable
  path is automated, but a real notched phone/foldable remains a manual check.
- Huawei Pura X, TalkBack, installed-PWA rotation, Android power saving, and
  background/lock-screen playback were not executed in this local milestone.
- Nothing was pushed, deployed, tagged, or run against remote Actions.
