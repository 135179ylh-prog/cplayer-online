# Research - Font footprint optimization

## Baseline

The committed Pages artifact measured 43,695,486 bytes. The four Noto Sans SC
TTF files measured 42,126,576 bytes in total and each exposed approximately
30,890 Unicode mappings / 30,796 glyph slots.

## Conversion probe

FontTools 4.63.0 directly compressed each source TTF to WOFF2, retaining the
source hinting/prep data. The measured outputs were:

| Weight | WOFF2 bytes |
| --- | ---: |
| 400 | 4,175,360 |
| 500 | 4,248,628 |
| 700 | 4,295,288 |
| 900 | 3,982,796 |

The four WOFF2 files total 16,702,072 bytes. The old TTF files remain only in
Git history for comparison and are not part of the working tree or artifact.

The output cmap sets were compared against their corresponding TTF sources
before integration; no codepoint was intentionally removed. These binaries are
committed artifacts, not generated during CI.

## Scope decision

Font Awesome files under `webfonts/` remain unchanged. The Pages builder copies
that directory as a separate runtime dependency, and changing it would mix an
unrelated compatibility issue into this performance milestone.
