# Implementation - Runtime and Background Resilience

1. Add deterministic browser probes and regressions for the real Audio instance,
   transition-time session ownership, queue-empty media cleanup, Media Session
   seeking, readiness, animation lifecycle, and keyed-request cache isolation.
2. Add pure media-seek/session helpers to `js/core-utils.js` where their boundary
   behavior benefits from unit coverage.
3. Introduce committed media identity and a shared reset path in `js/app.js`, then
   route lifecycle persistence and both queue-empty paths through it.
4. Complete Media Session handlers/position publication and replace inferred app
   readiness with one explicit final boot transition.
5. Make the active visual loops idempotently start/stop on playback and document
   visibility; add the Service Worker keyed-request bypass and v58 revision.
6. Update static contracts and frontend quality guidance, run focused checks,
   inspect failures, then run `npm run verify` on `PW_PORT=4175`.
7. Record exact evidence and residual device-only risk, commit locally, archive
   the task, and record the Trellis journal without pushing or deploying.
