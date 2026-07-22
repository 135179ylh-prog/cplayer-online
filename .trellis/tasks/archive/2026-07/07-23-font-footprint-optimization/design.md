# Design - Font footprint optimization

## Asset strategy

Keep one local face per existing weight so browser selection and visual weight
remain unchanged. Convert each TTF with FontTools' WOFF2 compressor, retaining
the complete cmap and hinting tables rather than making an application-text
subset. The conversion is a development-time artifact operation; CI only checks
the committed binary files.

The four output names mirror the current names with a `.woff2` extension. The
old TTF files are removed from `fonts/` so the Pages builder cannot copy a
second, unused copy into the deployment artifact.

## Runtime and cache ownership

`css/noto-sans-sc.css` remains the single font-face owner. It maps 400, 500, 700,
and 900 to the same family and uses `format('woff2')`. The Service Worker still
precaches the CSS but obtains font binaries through its normal same-origin
runtime cache branch. Bump `CACHE_NAME` so an installed PWA cannot retain the
old CSS/TTF combination.

## Verification design

The existing Pages artifact test is extended rather than creating a second
artifact server. It will:

1. Request the CSS, four WOFF2 files, and four removed TTF paths, checking status
   and MIME type.
2. Navigate with a real Service Worker, explicitly call `document.fonts.load`
   for every weight with dynamic-looking Chinese/Latin/punctuation sample text,
   and assert loaded `FontFace` entries plus WOFF2 resource responses.
3. Inspect the current cache for all four font URLs, go offline, reload the app,
   and repeat the font checks. This proves the runtime cache path, not only a
   direct HTTP response.

A one-off FontTools cmap comparison is recorded in `research.md`; no runtime
dependency on Python font tooling is introduced.

The repository hygiene checker classifies staged files by their original path
before calling `git show`. Known binary assets are counted and skipped without
buffering their blob, while text diagnostics retain the `(staged)` label. This
keeps the release gate usable when the replacement WOFF2 files are staged.

## Compatibility and rollback

The family/weight contract, HTML markup, and data schemas do not change. A
rollback restores the four TTF files, the CSS URLs, and the previous Worker
cache name as one commit. Font Awesome's separate `webfonts/` directory remains
untouched.
