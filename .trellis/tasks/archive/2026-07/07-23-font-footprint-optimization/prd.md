# Font footprint optimization

## Goal

Reduce the Pages artifact and first-install transfer size by replacing oversized local TTF webfonts with verified WOFF2 assets while preserving Chinese glyph coverage, typography, offline behavior, and release-gate guarantees.

## Requirements

- Replace the four local Noto Sans SC weight files in `fonts/` (400, 500, 700,
  and 900) with WOFF2 assets generated from the complete source glyph maps.
- Keep the existing family name, weight mapping, `font-display: swap`, and
  dynamic-song fallback behavior. Do not subset to only the text currently in
  the HTML because song titles, artists, and lyrics are runtime data.
- Update the font CSS to reference only the new WOFF2 files and update the
  Service Worker cache revision because the CSS is a precached production asset.
- Do not change Font Awesome assets under `webfonts/`, playback/API/storage
  behavior, the database schema, or the Pages artifact allowlist.
- Extend deterministic artifact/browser checks to prove MIME type, all four
  weights, absence of old TTF files, online font loading, current-cache
  population, and offline reload font availability.
- Keep the repository hygiene check safe for large staged binary assets and add
  a regression test so a staged WOFF2 cannot overflow the Git snapshot buffer.
- Keep the generated assets and source files free of credentials and unrelated
  test-only branches.

## Acceptance Criteria

- [x] Each WOFF2 preserves the source font's Unicode codepoint set and weight;
  representative Chinese, punctuation, Latin, and numeric glyphs load in the
  browser for all four weights.
- [x] `css/noto-sans-sc.css` contains four WOFF2 faces and no TTF/truetype
  reference; the four old Noto TTF paths return 404 from the Pages artifact.
- [x] Pages artifact contains exactly four files in `fonts/`, and its recorded
  size is at least 50% smaller than the 43,695,486-byte baseline (target <=
  20,000,000 bytes).
- [x] Desktop `1280x800` and mobile `390x844` artifact tests observe all four
  WOFF2 faces loading with `font/woff2`, then confirm the same faces work after
  an offline reload from the current Service Worker cache.
- [x] Existing unit, syntax, feature, dependency, browser, and repository
  checks pass through `npm run verify`.
- [x] A staged large-binary repository-check regression passes without reading
  the entire WOFF2 blob through the text inspection path.
- [x] Verification evidence, the frontend quality contract, task archive, and
  journal are updated; changes are committed locally without push or deploy.

## Baseline

- The previous Pages artifact was 43,695,486 bytes; the four Noto TTF files
  accounted for 42,126,576 bytes.
- A complete-glyph FontTools conversion measured approximately 16.7 MB across
  the four WOFF2 files before integration. The final artifact size is measured
  by `npm run build:pages`, not inferred from source file sizes.
