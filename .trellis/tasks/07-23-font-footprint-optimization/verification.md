# Verification - Font footprint optimization

## Result

All acceptance criteria passed on 2026-07-23. No push or deployment was
performed.

## Asset evidence

- Baseline Pages artifact: 43,695,486 bytes.
- Final Pages artifact: 24 files, 18,270,968 bytes.
- Reduction: 25,424,518 bytes (58.1857%); final artifact is 41.8143% of the
  baseline and below the 20,000,000-byte budget.
- Noto font total: 16,702,072 bytes (old TTF total was 42,126,576 bytes).
- `output/pages/fonts/` contains exactly four WOFF2 files and no Noto TTF.
- FontTools 4.63.0 comparison against the TTF blobs at `HEAD` reported, for
  every weight 400/500/700/900: 30,796 glyphs, 30,890 Unicode cmap entries,
  identical cmap sets, U+4E2D present, identical OpenType table sets including
  `prep`, and matching weight/family metadata.

## Commands and results

| Command | Result |
| --- | --- |
| `npm run test:unit` | 26 passed, 0 failed |
| `npm run check:module` | passed |
| `npm run check:sw` | passed |
| `python tests/verify_features.py` | passed |
| `npm run build:pages` | 24 files, 18,270,968 bytes |
| `npm run test:e2e -- --grep "Pages artifact"` with `PW_PORT=48124` | 4 passed (desktop 1280x800 and mobile 390x844, including offline reload) |
| `npm run verify` with `PW_PORT=48127` | 9/9 layers passed; 166 browser scenarios: 154 passed, 12 skipped, 0 failed |
| `npm run check:repo` | passed with 19 staged paths and 4 known binary assets skipped before blob reads |

The full gate emitted only the existing Browserslist `caniuse-lite` freshness
notice; it did not fail the gate and was not changed in this scoped task.

When the four WOFF2 files were first staged, `check:repo` reproduced
`spawnSync git ENOBUFS`: the checker read each complete binary with `git show`
before classifying its extension, and the `(staged)` display suffix also hid the
real extension. The new large-staged-WOFF2 test failed before the fix and passed
after classification moved ahead of the blob read. Existing staged non-UTF-8
source and file-type-change regressions remained green.

## Browser coverage

The artifact test checked CSS block-to-weight mapping, WOFF2 MIME, removed TTF
404s, explicit `document.fonts.load` for dynamic Chinese/Latin/punctuation
sample text, current Worker CacheStorage entries, and offline reload for all
four weights in both the desktop and mobile projects.
