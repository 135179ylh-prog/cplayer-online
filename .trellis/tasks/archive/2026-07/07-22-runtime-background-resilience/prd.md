# Runtime and background resilience

## Goal

Make the media that the browser is actually playing the single source of truth
for resume state, system controls, queue cleanup, and visual work. The player
must remain deterministic while a new song request is pending, after the queue
becomes empty, and while the page is paused or hidden.

## Context

- The main `Audio` object is created with `new Audio()` and is not attached to
  the DOM. The existing playback-error assertion can therefore pass without
  inspecting the real player.
- `activePlaybackAttempt` changes before the requested song URL arrives. During
  that gap, lifecycle saves can combine the new song id with the old media time.
- Removing the final queue item pauses audio but can retain its source, active
  attempt, and Media Session metadata, allowing a system play command to revive
  removed media.
- Media Session seeking is incomplete and accepts unbounded input.
- Decorative WebGL and analyser loops continue scheduling frames while they have
  no visible or audible work.
- A custom same-origin API base can route an `apikey` URL through the generic
  Service Worker cache path, even though the credential must remain runtime-only.

## Requirements

- Keep request attempts separate from the media identity committed to the main
  `Audio` object. Playback-session persistence must use only the committed
  identity and must never pair a pending song id with an older source/time.
- While a replacement request is pending, play/resume controls and `ended`
  handling must continue to use the committed media identity. They must not
  become disabled or skip past the user's pending selection.
- Provide one idempotent media-reset path for final-song removal and explicit
  queue clearing. It must invalidate pending work, pause and unload audio, clear
  resume data, clear player/media-session identity, and leave system play unable
  to revive removed media.
- Complete Media Session controls with bounded `seekto`, `seekbackward`, and
  `seekforward`, plus safe position-state updates and cleanup.
- Publish an explicit application-ready signal only after persisted queue state,
  event handlers, Media Session handlers, and mobile UI initialization are ready.
- Make active animation loops lifecycle-aware. Paused or hidden states must not
  keep requesting frames for audio-reactive or decorative rendering; restarting
  must be idempotent, and a paused visible resize must redraw one static frame.
- Any GET request whose URL contains the `apikey` query parameter must bypass
  CacheStorage regardless of hostname or origin.
- Browser tests must observe the real `Audio` and Media Session boundaries via
  pre-navigation probes. Production code must not contain a test mode or fixture
  branch, and no live third-party request or real credential may be used.

## Constraints

- Preserve the default `.top` API behavior and all existing storage formats.
- Do not add an audio element solely for testing.
- Do not push, deploy, or use a real API key.
- Advance the Service Worker cache revision for changed precached production
  assets.

## Acceptance Criteria

- [x] A browser regression proves the playback-error path pauses the actual main
  `Audio` instance; the test fails if no instance was captured.
- [x] While song B is waiting on its API response, lifecycle persistence never
  stores song B with song A's current time or duration.
- [x] While B is pending, system play can resume paused committed song A; an A
  `ended` event cannot cancel B or request the following song C.
- [x] A source switch followed by autoplay rejection leaves audio/UI/system state
  paused and allows a later user/system play command to recover.
- [x] Removing the final song and clearing the queue both leave the main audio
  source empty, current media identity absent, Media Session metadata cleared,
  playback state `none`, and a captured system play command unable to restart it.
- [x] Media Session backward/forward/absolute seeks clamp finite values to the
  current duration, ignore invalid input, and publish valid position state.
- [x] `waitForAppReady` consumes the explicit ready signal and returns only after
  restored queue and required UI/system handlers are usable.
- [x] Frame-count regressions prove playback pause and page hiding stop relevant
  animation scheduling, resume/visibility restart exactly one loop, and paused
  resize redraws without starting a loop.
- [x] A same-origin request containing a generated `apikey` cannot be served from
  or written to the application cache; reset/default API requests remain intact.
- [x] Unit, syntax, static contract, focused Playwright, full Playwright, audit,
  CSS freshness, and whitespace gates all pass.
- [x] Frontend quality contracts and task verification evidence are updated; all
  work remains local without push or deployment.

## Notes

- Manual Huawei background playback and lock-screen behavior remain device-only
  evidence. Automated Media Session tests prove handler contracts, not OEM power
  management behavior.
