# Research - API Key and Base-URL Configuration

## Upstream Behavior

Verified on 2026-07-21 before implementation:

- `https://api.chksz.top/api` still supports the existing key-free request.
- `https://api.chksz.com/api` requires the query parameter named exactly
  `apikey` and can report missing credentials as HTTP 200 with JSON code 401.
- A public GitHub Pages app cannot hide a shared key in deployed JavaScript.
  Therefore the only in-scope model is a user-supplied value stored in that
  browser and sent to the user-selected API address.

No live API call is part of automated verification, and no credential value is
recorded here.

## Existing Boundaries

- Four API paths exist: search, song URL, lyric, and remote playlist.
- `fetchJsonWithRetry` already converts non-2xx responses to errors with a
  numeric status and retries only transient failures.
- Search and playback already have recovery UI suitable for an auth category.
- `index.html` and `js/core-utils.js` are precached, so this change requires a
  Service Worker cache-name revision.

## Review Findings

- Base validation must reject credentials, query strings, and fragments rather
  than only checking an `http` prefix.
- The upstream auth code can appear in a successful HTTP response body, so it
  must be normalized centrally before individual services inspect payload data.
- Auth failures cannot be repaired by replaying the same request or skipping to
  the next song; playback recovery must stop.
- The remote-playlist service previously converted every failure to an empty
  list. For auth errors this caused the actionable key message to be replaced
  by a generic playlist-ID error. Auth errors now propagate to the UI boundary.
- Route-mocked Playwright tests must block Service Workers or the page route can
  be bypassed.
