# Design - Runtime and Background Resilience

## State model

Use two explicit owners instead of treating an API request as active media:

```text
playback attempt (pending network work)
        |
        | successful playable URL commit
        v
committed media identity (song id + token + normalized source)
        |
        +--> playback-session snapshot
        +--> Media Session metadata/position
        +--> reset and queue-empty behavior
```

`activePlaybackAttempt` continues to cancel stale async work. A separate
`committedMedia` record changes only when a URL is assigned to the main audio
object. Session saving validates this identity against the audio source and
declines ambiguous snapshots. A shared reset invalidates attempts before
unloading the audio and clearing system metadata.

Play/resume and `ended` events also resolve through `committedMedia`. A newer
pending attempt cannot disable control of the currently bound source, and an
`ended` event from that source cannot advance from the pending attempt's queue
index. Assigning a replacement source synchronizes paused UI/system/visual state
before attempting autoplay, because native `src` replacement can pause without a
`pause` event.

## Boot readiness

Initialization owns one explicit readiness transition. It occurs after the
IndexedDB open/queue restore path, core event registration, Media Session setup,
and mobile UI construction. Tests wait on this transition rather than guessing
from unrelated global functions. The signal is normal runtime state, not a
test-only branch.

## Media Session boundary

- One seek helper validates a finite duration and target, clamps to `[0,
  duration]`, and uses `fastSeek` only when available.
- `seekto`, `seekbackward`, and `seekforward` all use the same helper.
- Position publication catches unsupported-browser errors and only sends finite
  `{ duration, position, playbackRate }` values.
- Reset calls `setPositionState()` without arguments, clears metadata, and sets
  playback state to `none`.

## Visual lifecycle

Each continuously animated component owns at most one request id and exposes an
idempotent state sync. Scheduling is allowed only when the document is visible
and the component has useful work. Playback events and `visibilitychange` call
the shared sync points; pausing or hiding cancels already scheduled work. Canvas
resize while paused redraws one visible static frame because resizing clears the
WebGL drawing buffer.

The lyrics canvas is outside the change unless tests prove it starts during the
current flow. This avoids rewriting dormant code without evidence.

## Service Worker privacy boundary

Before any cache lookup, the fetch handler checks `url.searchParams.has('apikey')`.
Matching requests are network-only for arbitrary custom API hosts, including
same-origin proxies. Existing ChKSz hostname bypass rules remain as defense in
depth. The cache revision advances because both the Worker and precached app
module change.

## Test strategy

- Install an `Audio` constructor probe before navigation. Preserve native-like
  behavior while recording instances, source, and play/pause calls.
- Install a Media Session probe before navigation to capture handlers, metadata,
  playback state, and position updates.
- Hold the second song response at the network boundary to reproduce the
  transition window deterministically.
- Exercise queue removal through real UI/application commands and assert browser
  boundary state, not source strings alone.
- Count animation scheduling/cancellation around play, pause, hide, and resume.
- Use only generated fake key values and a controlled same-origin test endpoint
  for Service Worker cache isolation.

## Failure handling

- Unsupported Media Session actions or position updates remain non-fatal.
- Invalid duration/seek input is ignored without corrupting audio time.
- Media reset is best-effort for browser APIs but always clears application
  identity synchronously.
- A rejected or stale song request cannot reattach media after reset because its
  attempt token has been invalidated.

## Release impact

- No storage migration or new dependency.
- `js/app.js`, `sw.js`, tests, and the frontend quality contract change.
- `CACHE_NAME` advances from v57 to v58.
- No push or deployment is part of this task.
