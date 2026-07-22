# Design - Mobile landscape and accessibility hardening

## Compact landscape ownership

One explicit media query owns the exceptional layout:

```text
orientation: landscape + width <= 900px + height <= 500px
        |
        +-- hide desktop layout
        +-- show mobile layout as a two-column grid
        +-- header spans both columns
        +-- cover/metadata stays in the left column
        +-- progress and controls stay in the right column
```

This avoids changing Tailwind's global `md` breakpoint. Portrait phones and
full desktop viewports retain their current layout. The record uses a
height-bounded size so a wide-but-short viewport cannot select the 300px inline
size. Compact margins are owned by stable mobile element IDs, and both columns
use `minmax(0, ...)` to prevent content-driven overflow.

The header stays present at 48px rather than inheriting the existing short-screen
hide rule. This preserves access to lyrics and Settings in landscape. Core
controls remain fixed-size touch targets; only spacing and record size compress.

`mobileLayoutQuery` mirrors the union of the normal sub-768px mobile breakpoint
and the compact landscape query. `MobileUIManager` closes its sheet only when
that union becomes false, so portrait-to-landscape rotation preserves open UI
state while a true switch to desktop still closes mobile-only controls.

## Drawer semantics

The desktop drawer header remains the visual flex row, but the two tabs move into
a dedicated inner `role="tablist"`. `#clearQueueBtn` and the hidden upload input
remain sibling actions outside that tablist. Existing JavaScript binds from a tab
to `parentElement`, so the new inner wrapper becomes the correct keyboard event
owner without a business-logic change.

Opened playlist and search states are Axe-scanned because closed inert content is
not represented in the accessibility tree. The browser test also asserts that
every direct tablist child has `role="tab"`.

## Safe-area contract

The viewport declares `viewport-fit=cover`. Root variables provide one source of
truth:

```css
--cp-safe-area-top: env(safe-area-inset-top, 0px);
--cp-safe-area-right: env(safe-area-inset-right, 0px);
--cp-safe-area-bottom: env(safe-area-inset-bottom, 0px);
--cp-safe-area-left: env(safe-area-inset-left, 0px);
```

The variables apply to `#mobileLayout`, the two header buttons,
`#mobileBottomControls`, and `#mobilePlaylistSheet`. Browser tests override the
same production variables with non-zero values; Chromium cannot emulate a notch,
so this proves selector ownership without introducing a test-only code path.

## Reduced-motion lifecycle

A shared MediaQueryList for `(prefers-reduced-motion: reduce)` is the runtime
owner. Both visual `should*()` predicates require the preference to be false.
The query's `change` event calls the existing `syncVisualLifecycle()` so an
active WebGL/visualizer loop is canceled immediately. The older Safari
`addListener` API is retained as a compatibility fallback.

CSS reduces animations to one near-zero-duration iteration, makes transitions
near-instant, and changes smooth scrolling to `auto`. JavaScript still permits
single-frame focus, resize, static WebGL rendering, and virtual-list updates.
Audio state is independent and remains playing.

## Browser coverage

Two responsive-only Playwright projects cover `844x390` and `740x360`. The
responsive suite owns layout geometry, safe-area injection, tab semantics, and
opened-state Axe checks, including a portrait-to-landscape state transition. The
existing runtime resilience suite reuses its real RAF, Audio, Media Session, and
mocked API probes for reduced-motion lifecycle tests.

## Compatibility and rollback

No IndexedDB, queue, playlist, API, or Service Worker schema changes occur. The
cache name advances to `cplayer5-v60-mobile-landscape-accessibility` so installed
PWAs fetch the changed precached HTML/module. Reverting this milestone restores
the prior CSS/DOM/visual lifecycle and cache name without data migration. No
push or deployment is part of this task.
