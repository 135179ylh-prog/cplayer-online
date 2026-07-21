# Design - API Key and Base-URL Configuration

## Boundary Map

```text
settings inputs -> localStorage(cp_api_key/cp_api_base)
               -> ChKSzAPI.baseUrl/apiKey/buildUrl
               -> fetchJsonWithTimeout/fetchJsonWithRetry
               -> response-body auth normalization
               -> MusicService / PlaylistService / search or playback UI
```

`ChKSzAPI` owns the request URL contract. `fetchJsonWithTimeout` owns the
HTTP-200 JSON `{code: 401|403}` normalization so callers do not each interpret
the upstream auth shape. `classifyPlaybackFailure` owns the user-facing auth
category shared by playback and search recovery.

## URL Contract

- Default base comes from the existing `meta[name="cplayer-api-base-url"]`
  value (`https://api.chksz.top/api`).
- A stored custom base must parse as an absolute `http:` or `https:` URL with a
  host; query strings, fragments, credentials, and malformed values are
  rejected on save. A malformed stored value falls back to the default.
- `buildUrl(path, params)` uses `URLSearchParams`, appends a non-empty trimmed
  `apikey` from localStorage, and returns no key parameter when none is set.
- Four endpoints use the builder: `/163_search`, `/163_music`, `/163_lyric`,
  and `/163_playlist`.

## Auth Error Flow

- A non-2xx 401/403 and a successful HTTP response whose JSON `code` is 401/403
  become an `Error` with numeric `status` and the upstream message attached.
- Auth errors are never retried by `shouldRetryRequest`.
- Search recovery keeps its query/panel state and displays
  `API 密钥无效或额度已用完，请在设置中检查密钥` for an auth error; other online
  search failures retain `搜索服务暂不可用` and offline keeps `当前已离线`.
- Playback stops recovery and keeps the queue in place because retrying or
  skipping songs cannot repair an invalid key; it shows the same auth message.
- Playlist/lyric callers may keep their existing data fallback for non-auth
  errors, but an auth failure must not be silently mistaken for an empty
  successful response or overwritten by a generic playlist-ID error.

## UI State

- Settings fields are password/text inputs with labels and a live status region.
- Opening settings reads current localStorage values and displays the effective
  base, including the default when no custom base is stored.
- Save validates and normalizes first, then writes both keys atomically from the
  user's perspective; reset removes both keys and immediately restores default
  UI state.
- No API key value appears in committed source, task docs, test fixtures, or
  browser test artifacts.

## Cache and Compatibility

Changing `index.html` or `js/core-utils.js` changes precached production code,
so the Service Worker cache name must advance. No API data or IndexedDB schema
changes are introduced.
