# Research - Runtime and Background Resilience

## Confirmed findings on HEAD 66ca4a7

- `savePlaybackSession` reads the id from `activePlaybackAttempt` while reading
  time/duration from the main audio object. `loadAndPlaySong` changes the attempt
  before awaiting `/163_music`, creating a deterministic cross-song write window.
- Final-item removal pauses audio but does not invalidate the attempt, unload the
  source, or clear Media Session metadata. Explicit queue clearing invalidates the
  attempt but still leaves the media source and system metadata behind.
- `playback-error.spec.mjs` queries a DOM `<audio>` element even though production
  creates an unattached `new Audio()`; its null fallback makes the assertion
  vacuous.
- Media Session registers play/pause/previous/next/seekto only. Absolute seek is
  not validated, and no `setPositionState` call exists.
- The main analyser loop schedules before checking whether an analyser or active
  playback exists. The fluid WebGL background starts with `isPlaying=true`,
  reschedules unconditionally, and has no lifecycle caller.
- `waitForAppReady` waits for selected globals. Queue restoration usually lands
  first, but mobile UI is created later by a timer, so the helper is not a full
  boot contract.
- `sw.js` bypasses known ChKSz hosts, but an arbitrary same-origin custom API base
  can reach the generic local-resource cache with `apikey` in its request URL.
- Native Chromium source replacement pauses a playing `HTMLAudioElement` without
  providing the pause-state transition the old UI logic relied on. A blocked
  replacement play can therefore leave `isPlaying` stale unless source commit
  synchronizes paused state explicitly.
- When A is committed and B is pending, control and ended handling must use A's
  identity. Reading the pending attempt/current index disables resume and can
  advance to C, cancelling B.

## Existing evidence to preserve

- API configuration task `07-21-api-key-config` is completed and archived.
- Current release gate baseline: 10 unit tests and 82 browser cases (80 passed,
  2 intentional skips) at the previous release-candidate audit.
- Target deterministic viewports are desktop `1280x800` and mobile `390x844`;
  narrow `355x800` and foldable `440x707` remain targeted for responsive-only
  regressions unless shared layout changes.

## Relevant contracts

- `.trellis/spec/frontend/quality-guidelines.md`
- `.trellis/spec/guides/cross-layer-thinking-guide.md`
- `.trellis/spec/guides/code-reuse-thinking-guide.md`

## Break-loop analysis

### 1. Root cause category

- **B - Cross-layer contract**: pending API request state was used as though it
  were the source already committed to the browser media element.
- **D - Test coverage gap**: the old error test treated a missing DOM audio node
  as success, and readiness/animation checks inferred state rather than observing
  the browser boundary.
- **E - Implicit assumption**: source replacement, `currentTime` setters, Media
  Session actions, and hidden-page animation were modeled differently from real
  Chromium behavior.

### 2. Why earlier protection failed

1. Attempt tokens protected stale network callbacks but did not identify which
   source owned `audio.currentTime`, `ended`, or system play.
2. Source-string/static checks proved code existed but not that queue, media,
   storage, and system state moved together.
3. The first Audio probe silently ignored non-finite seeks, reproducing the
   desired outcome instead of the native exception boundary; independent review
   exposed and corrected it before the full gate.

### 3. Prevention mechanisms

| Priority | Mechanism | Specific action | Status |
| --- | --- | --- | --- |
| P0 | Architecture | Separate pending attempts from committed media identity. | Done |
| P0 | Browser regression | Probe real Audio/Media Session boundaries before navigation. | Done |
| P0 | Cross-flow regression | Hold replacement requests and exercise pagehide, play, ended, failure, and reset. | Done |
| P1 | Runtime lifecycle | Give animation loops one request owner and explicit pause/hide/resize behavior. | Done |
| P1 | Documentation | Preserve executable contracts and review checklist in frontend/cross-layer specs. | Done |

### 4. Systematic expansion

- The same requested-versus-committed distinction should be checked when adding
  future image caches, downloads, casts, or external playback devices.
- IndexedDB lifecycle errors (`blocked`, `versionchange`, rejected storage) and
  cache eviction remain a separate storage-resilience milestone rather than
  being hidden inside this playback task.

### 5. Knowledge capture

- [x] Frontend deterministic playback/runtime contract added.
- [x] API-key CacheStorage exclusion added to the API contract.
- [x] Cross-layer checklist now calls out requested versus committed identity and
  browser-faithful probes.
- [x] Unit, static, desktop/mobile browser, and complete release gates recorded.
