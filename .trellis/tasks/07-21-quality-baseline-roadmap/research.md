# Research - Quality Baseline and Roadmap

## Confirmed Baseline

- Runtime: static HTML/CSS/JavaScript PWA deployed by GitHub Pages.
- Main runtime: `index.html`, with an ES module script and browser storage.
- Shared pure logic: `js/core-utils.js` with nine Node unit tests.
- Static verifier: `tests/verify_features.py`, currently protecting source,
  manifest, deployment, cache, and documentation invariants.
- Syntax verifier: `scripts/check_module_syntax.py` plus `node --check sw.js`.
- Deployment: `.github/workflows/pages.yml` stages an explicit static asset
  allowlist but has no build/test dependency.
- PWA: `manifest.json` plus `sw.js`; the current cache is
  `cplayer5-v51-search-retry` and the app shell has ten core assets.
- External boundary: search, song URL, lyrics, and remote playlists depend on
  ChKSz endpoints. Deterministic tests must mock this boundary.

## Existing Evidence Matrix

| Flow | Current evidence | Strength | Gap / severity | Goal phase |
| --- | --- | --- | --- | --- |
| Search | request-race guards plus deterministic desktop/mobile failure-to-retry browser tests | High | request ordering and add/play flows still need broader browser coverage; P1 | 2 |
| Playback | utility tests for failure classification, resume and quality; prior manual run | Medium | browser media/error state not automated; P1 | 2 |
| Queue | source checks for serialized IndexedDB writes and restore | Low | no browser round-trip/reload proof; P0 | 2 |
| User playlists | archived manual CRUD/order evidence | Low | no repeatable IndexedDB CRUD test; P1 | 2 |
| Recent history | source checks and prior manual UI run | Low | no dedupe/limit browser proof; P1 | 2 |
| Backup restore | source validation and prior manual import/export run | Low | no atomic invalid/valid import browser proof; P0 | 2 |
| Offline shell | source checks plus active-controller online-to-offline browser reload | High | cache upgrade from an older version remains untested; P1 | 3 |
| Update flow | cache naming and cleanup source checks | Low | no old-to-new cache activation test; P1 | 3 |

## Decisions

- Establish deterministic browser evidence before large module/build changes.
- Use real browser storage and Service Worker behavior, while mocking only the
  external network boundary.
- Keep live API checks informational; upstream outages must not fail local CI.
- Start with Chromium desktop/mobile profiles, then retain real-device and
  WebKit checks as later release gates.

## Phase 2 Priority Input

1. P0: prove queue add/remove/save/reload round trips in browser storage.
2. P0: prove valid backup import and invalid atomic rollback without losing
   existing playlists.
3. P1: prove user-playlist CRUD/order and recent-history dedupe/limit behavior.
4. P1: extend mocked playback coverage to media errors, bounded skip, progress
   persistence, and user-gesture resume.
5. P1: retain old-to-new Service Worker cache activation for Phase 3, where
   offline/update behavior is the owning scope.
