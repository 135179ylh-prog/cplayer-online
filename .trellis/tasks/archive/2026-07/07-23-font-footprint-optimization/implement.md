# Implementation - Font footprint optimization

1. Record source file sizes, glyph/codepoint counts, and the current Pages
   artifact byte count.
2. Generate four complete-glyph WOFF2 files from the Noto TTF sources with the
   direct FontTools WOFF2 compressor (preserving hinting), and compare each
   output cmap/codepoint set with its source.
3. Copy the generated binaries into `fonts/`, remove only the four old Noto
   TTF files, and update `css/noto-sans-sc.css` URLs/formats.
4. Advance `sw.js` `CACHE_NAME` and the matching static expectation in
   `tests/verify_features.py`.
5. Extend `tests/e2e/release-artifact.spec.mjs` with online/offline font loading,
   MIME, cache, and removed-asset assertions.
6. Harden `scripts/check-repository-state.mjs` to skip known staged binaries
   before `git show`, and add the large-WOFF2 regression to
   `tests/release-preflight.test.mjs`.
7. Update the frontend quality contract with the font asset and offline-cache
   rules, then run focused browser checks from `output/pages`.
8. Run `npm run verify`, capture counts/bytes/viewports in `verification.md`,
   inspect the final diff, commit locally, archive the task, and record journal.

## Risk controls

- Never use a static page-text subset: dynamic song metadata and lyrics need the
  full source cmap.
- Keep `webfonts/` out of the change; it belongs to Font Awesome and has a
  separate fallback contract.
- If a browser font load fails, stop before deleting source assets and inspect
  CSS URL case, MIME, glyph coverage, and Worker cache revision.
