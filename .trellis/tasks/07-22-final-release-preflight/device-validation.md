# Device and remote validation - not yet executed

Only mark an item after testing the exact deployed commit. Chromium emulation is
useful evidence but does not replace Huawei/Android power management, system
media UI, safe areas, or TalkBack.

## Environment record

| Item | Result |
| --- | --- |
| Date | Not executed |
| Deployed commit | Not executed |
| Actions run URL | Not executed |
| Pages URL/build badge | Not executed |
| Device/system | Not executed |
| Browser/PWA version | Not executed |
| Install mode | Not executed |

## Release blockers

- [ ] On the remote Pages URL, required public assets return 200 and
  `/.trellis/`, `/tests/`, `/scripts/`, and `/package.json` return 404.
- [ ] First install completes without an update loop; a later deployment shows
  one refresh/dismiss prompt and preserves queue, playlists, recent history, API
  settings, and recoverable playback position.
- [ ] Huawei Pura X portrait, unfolded/wide state, `844x390` landscape, and a
  short-height keyboard state keep title, artist, quality, progress, primary
  playback controls, and bottom actions visible and reachable.
- [ ] Top/right/bottom/left safe areas do not cover controls, update feedback,
  dialogs, or the mobile sheet.
- [ ] Play a two-song queue, background the PWA for 60 seconds, then lock for 60
  seconds. Audio continues and progress does not restart or jump.
- [ ] Lock screen and system media notification show current metadata and usable
  play/pause/previous/next actions; page state follows system actions.
- [ ] Switch Wi-Fi to mobile data and then offline. Failure feedback is clear;
  local library remains available; reconnecting allows retry without data loss.
- [ ] Create a playlist, add/reorder/remove songs, export it, delete it, and
  import the exported file. Song order and user data survive.
- [ ] TalkBack announces dynamic play/pause action, selected tabs, current queue
  item, progress value, update notification, and topmost dialog in a useful order.
- [ ] All opened panels/dialogs pass an Android accessibility scan with no
  critical/serious issue; focus returns to the opener on close.

## Recommended follow-up

- [ ] Reduced-motion stops the rotating cover and continuous WebGL work.
- [ ] Five-minute playback in power-saving mode remains controllable.
- [ ] Bluetooth headset play/pause/previous/next works.
- [ ] Incoming audio interruption returns control cleanly to the player.
- [ ] Cold-start the installed PWA offline and inspect local queue/playlists;
  reconnect and retry search from the same state.
- [ ] Measure first-install transfer on mobile data after font optimization and
  record total bytes, load time, and any long task.
- [ ] Open and scroll a 1000-song user playlist; record DOM node count, image
  requests, interaction delay, and memory behavior.

## Failure record

For each failure record the commit, device/system/browser, installed or tab
mode, viewport/fold state, network/power state, exact steps, expected/actual
result, reproducibility, and a screenshot or screen recording.
