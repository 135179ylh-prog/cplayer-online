# Mobile landscape and accessibility hardening

## Goal

Close verified mobile landscape clipping and opened-sidebar accessibility gaps, add deterministic landscape regression coverage, and align safe-area/reduced-motion behavior without changing player data or API contracts.

## Background

- At `844x390`, Tailwind's `md` breakpoint selects the desktop layout. The main
  play control is clipped below the viewport and the mobile controls are absent.
- At `740x360`, the mobile layout is selected, but the 300px record starts at
  `y=-158.39`; most of the cover and all song metadata are clipped.
- When the desktop playlist/search drawer opens, Axe reports the critical
  `aria-required-children` rule because `#clearQueueBtn` is a direct child of a
  `role="tablist"`. The closed drawer and mobile sheet do not expose this defect.
- The current safe-area block targets nonexistent `#mobileUI` and
  `.mobile-controls` selectors, excludes the 844px landscape case, and the
  viewport metadata omits `viewport-fit=cover`.
- Continuous CSS/WebGL visual motion does not honor
  `prefers-reduced-motion`; playback and one-shot focus/render work must remain
  functional when motion is reduced.

## Requirements

- Treat landscape viewports up to 900px wide and 500px tall as the compact
  mobile player, including widths above the normal `md` breakpoint.
- Use that same layout boundary in JavaScript so rotating from portrait into
  compact landscape does not close an already open mobile sheet.
- Use a stable two-column landscape layout. Keep the header actions, record,
  song metadata, progress, primary playback controls, queue action, library
  action, and playlist trigger visible and inside the viewport at `844x390` and
  `740x360`.
- Preserve the existing portrait and desktop layouts outside the compact
  landscape media query. Do not change player data, API, queue, or storage
  contracts.
- Make the desktop tablist contain only the two tabs. Keep queue clearing as a
  separate action and preserve drawer focus, arrow-key, Escape, and trigger
  restoration behavior.
- Add `viewport-fit=cover` and one set of safe-area CSS variables. Apply them to
  the real mobile layout, header actions, bottom controls, and mobile sheet.
- Honor `prefers-reduced-motion` in both CSS and JavaScript. Stop recurring
  visual animation frames and smooth motion while leaving audio playing and
  allowing one-shot focus, resize, and list-render frames.
- Advance the Service Worker cache revision because the HTML and main app module
  are precached production resources; preserve the existing v4 data schema.
- Keep browser tests deterministic: block Service Workers in the responsive
  suite, mock only network/media boundaries, and never use a live ChKSz request
  or real API key.

## Acceptance Criteria

- [x] Playwright projects at `844x390` and `740x360` use the mobile layout; the
  cover, metadata, progress, playback buttons, secondary actions, and header
  controls remain visible, non-overlapping, and within the viewport.
- [x] Rotating an open mobile sheet from `390x844` to `844x390` keeps it open,
  expanded, and interactive because both viewports use the mobile layout.
- [x] The existing desktop, `390x844`, `355x800`, and `440x707` responsive
  checks remain green with no horizontal overflow or undersized mobile target.
- [x] Open playlist and search panel states have zero serious/critical Axe
  violations in every responsive project; tab semantics and keyboard behavior
  still pass.
- [x] Viewport metadata contains `viewport-fit=cover`, and deterministic browser
  injection of safe-area variables changes the real top, left, right, bottom,
  and sheet spacing as specified.
- [x] With reduced motion enabled before load, deterministic playback remains
  active, recurring visual RAF work is zero, CSS animation is not infinite, and
  smooth scrolling is disabled.
- [x] Changing reduced-motion preference during playback cancels the active
  visual loop and can restore one bounded loop when the preference returns to
  normal and WebGL is available.
- [x] Focused browser tests, unit tests, feature contracts, generated CSS drift
  check, and the complete `npm run verify` gate pass.
- [x] The responsive accessibility contract and task verification evidence are
  updated.
- [ ] Changes are committed and archived locally without push or deploy.

## Out Of Scope

- Font/package size reduction and complete user-library backup round trips.
- Real-device notch measurement, Huawei Pura X/TalkBack execution, or remote
  Pages deployment.
- Redesigning the desktop player, changing the `md` breakpoint globally, or
  changing third-party API behavior.
- Disabling all `requestAnimationFrame` calls; finite interaction and layout
  frames remain allowed.
