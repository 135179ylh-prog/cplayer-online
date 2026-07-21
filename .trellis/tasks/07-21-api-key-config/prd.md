# API Key and Base-URL Configuration

## Goal

Let a single user configure their personal ChKSz API key and API base URL from
the settings panel, stored only in their own browser (localStorage), so the app
keeps working as the upstream service moves to key-gated access — without ever
writing a secret into committed code or the deployed page source.

## Background

- The app talks to the ChKSz music API for search, song URL, lyrics, and remote
  playlists. All four requests are built in `index.html` and must use one
  centralized URL builder.
- Verified 2026-07-21:
  - Old host `https://api.chksz.top/api` still answers WITHOUT a key (HTTP 200).
  - New host `https://api.chksz.com/api` REQUIRES a key: without it returns
    `{code:401, msg:"缺少 apikey 参数，请先登录并查看个人密钥"}`.
  - The key is passed as a URL query parameter named `apikey`; passing it in a
    header or as `key=` does not satisfy the new host. A valid `apikey=` returns
    HTTP 200.
- The site is a public static PWA on GitHub Pages. Anything baked into the
  HTML/JS is world-readable, so a key must never be committed or hard-coded.
- The user chose to keep the default host on the old `.top` for now and only
  prepare the key/host inputs, switching hosts later when needed.

## Requirements

### AK-1: Settings inputs for key and base URL

Add two fields to the settings panel: an API key input and an API base-URL
input. Both persist to localStorage (`cp_api_key`, `cp_api_base`). The base-URL
field shows the current effective base and defaults to the existing `.top` host
when unset. Provide a visible save affordance and a clear confirmation.

### AK-2: Key applied to every ChKSz request

When a key is present, append `apikey=<key>` to all four ChKSz request URLs
(search, song, lyric, playlist). When no key is set, requests are unchanged so
the current key-free `.top` behavior is preserved. The key must be URL-encoded.
Base-URL and key handling must be centralized so all four call sites share it.

### AK-3: No secret in code or repo

The key is only ever read from localStorage at runtime. No key value is written
to any committed file, and the settings input must not pre-fill from a hard-coded
constant. `tests/verify_features.py` must assert no `apikey=`-with-literal-secret
or hard-coded key pattern exists in committed source.

### AK-4: Clear feedback on auth/quota failure

A 401 response (missing/invalid key or exhausted quota) must surface a clear,
localized message distinct from a generic network error, routed through the
existing playback/search recovery UI. The app must not appear silently broken.

### AK-5: Deterministic browser coverage

Add browser tests proving: (a) with a configured key, the outgoing request
carries the correct `apikey` query value; (b) a 401 shows the specific
key/quota message; (c) with no key set, requests carry no `apikey` parameter.
Mock the network boundary; never call the live API.

## Acceptance Criteria

- [x] Settings panel has working API key and base-URL inputs persisted to
      localStorage, defaulting to the current `.top` base.
- [x] All four ChKSz requests include `apikey` when a key is set and omit it
      when not, with the key URL-encoded and base-URL handling centralized.
- [x] No committed file contains a literal key; a feature check enforces this.
- [x] A 401 produces a clear key/quota message through the recovery UI.
- [x] Browser tests prove key-present request shape, 401 messaging, and
      key-absent request shape; all deterministic.
- [x] `npm run verify` passes; working tree has no uncommitted task code after
      the local Phase 3.4 commit and Trellis finish flow.

## Out of Scope

- Changing the default host to `.com` (user chose to stay on `.top` for now).
- Any server-side proxy or key-hiding backend (the app stays static).
- Multi-source / provider-switching (a later Goal-phase resilience item).
- Migrating request code out of `index.html`.
- Replacing the existing retry helper or moving request code out of
  `index.html`; a small shared auth-error classification extension is in scope
  because it powers consistent playback/search feedback.
