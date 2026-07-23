# Design - Optional accounts and playlist cloud sync

## Architecture

The existing static PWA remains the application and local source of truth. A
configured Supabase project adds authentication and a per-user cloud replica;
it is never required for boot or playback.

```text
Settings account UI
        |
        v
js/cloud-sync.js ----> vendored Supabase browser SDK
        |                         |
        |                         v
        |                Supabase Auth + RPC
        v                         |
js/app.js sync coordinator <------+
        |
        v
IndexedDB CPlayer5DB v5
  playlists + cloud_outbox
```

`js/cloud-config.js` is the single public configuration owner. It contains only
an empty/default project URL and publishable key until a real project is created.
Tests may provide the same runtime configuration boundary before page load; no
production test branch is added. The service-role key is never accepted.

## Authentication Boundary

- Use the official `@supabase/supabase-js` browser bundle, pinned and copied into
  `js/vendor/` by a reproducible script. Do not depend on a runtime CDN.
- Accept only an HTTPS Supabase project URL so passwords and session tokens never
  use a plaintext transport.
- Supply the SDK with the application's safe localStorage adapter so session
  persistence degrades through the same storage-health boundary as the player;
  rejected writes/removals fail the auth command instead of reporting success.
- Initialize authentication after `cplayer:ready`; a slow or failed auth request
  cannot delay IndexedDB restore, controls, Media Session, or playback.
- Support sign-up, password sign-in, sign-out, password recovery, recovery-mode
  password update, and account deletion. Email-confirmation success without a
  session is reported as “check your email”, not as a logged-in state.
- The account card owns one live status region and disables duplicate commands
  while a request is running.

## Local Storage Schema

Upgrade `CPlayer5DB` from v4 to v5 without replacing existing stores. Add:

```text
cloud_outbox (keyPath id)
  index ownerId
  index updatedAt
```

User playlist records keep their compatible fields and may add:

```js
{
  id: 'user_pl_*',
  name,
  songs,
  timestamp,
  cloudOwnerId,  // Supabase auth user id or '' for device-local
  cloudVersion,  // last acknowledged server version; 0 means never uploaded
  cloudDirty     // local content differs from the acknowledged version
}
```

An outbox record is a collapsed latest operation per owner and playlist:

```js
{
  id: ownerId + ':' + playlistId,
  ownerId,
  playlistId,
  operation: 'upsert' | 'delete',
  mutationId,      // random identity for this local mutation
  expectedVersion,
  playlist,       // normalized snapshot for upsert; absent for delete
  updatedAt
}
```

Normal playlist edits write the playlist and its outbox operation in one
transaction. Offline deletion removes the visible playlist and persists a delete
operation in that same transaction. Remote-applied writes suppress outbox
creation. Existing unowned playlists are adopted only by the user who starts a
sync while signed in.

`current_queue`, remote caches, lyrics, images, recent history, playback session,
sleep timer, API base/key, and SDK session records never enter playlist payloads.

## Cloud Schema And RLS

The checked-in migration creates `public.cplayer_playlists`:

```text
user_id uuid       -> auth.users(id), cascade delete
playlist_id text
name text
songs jsonb
version bigint
updated_at timestamptz
deleted_at timestamptz nullable
primary key (user_id, playlist_id)
```

Row Level Security (RLS) is mandatory. Select/insert/update/delete policies all
require `auth.uid() = user_id`. The browser never chooses an arbitrary user id;
RPC functions derive it from `auth.uid()`.

`sync_cplayer_playlist` and `delete_cplayer_playlist` use an expected version.
They insert only at expected version 0, otherwise update only the matching current
version and increment it. A mismatch raises `cplayer_playlist_conflict`.
New rows are serialized per user and capped at 500 total cloud rows.
`delete_cplayer_account` is a narrowly scoped security-definer RPC that deletes
only `auth.uid()` after revoking public access and granting authenticated access.

## Synchronization State Machine

Document state is exposed as `data-cplayer-cloud-state`:

```text
disabled -> signed-out -> syncing -> synced
                         |            ^
                         +-> pending --+
                         +-> conflict
                         +-> error
```

- `disabled`: no valid public cloud configuration; local player is fully usable.
- `signed-out`: cloud is configured but no session exists.
- `pending`: local outbox contains work or the browser is offline.
- `conflict`: at least one operation saw a newer server version.
- `error`: auth/sync service failed; local changes remain intact.

Sync runs after session restoration, after explicit “sync now”, after a local
edit debounce, and when connectivity returns. Only one run is active; another
trigger records a pending rerun.

## Merge And Conflict Rules

| Local | Cloud | Result |
| --- | --- | --- |
| unowned/new | absent | upload and attach returned owner/version |
| absent | active | download locally |
| clean at version N | version N | no-op |
| dirty at version N | version N | upload with expected N |
| clean below cloud version | newer active/deleted | apply cloud record/tombstone |
| dirty below cloud version | newer active/deleted | stop that item and show conflict choices |
| delete outbox at current version | active current version | write cloud tombstone, then remove outbox |

“Use local” retries against the currently displayed cloud version. “Use cloud”
applies the remote record/tombstone and removes the local outbox. Neither choice
affects other playlists.

## Account Transitions

- Signing out removes the SDK session but keeps local playlists and pending work.
  Outbox records retain their owner and cannot flush under a different account.
- Signing into another account filters sync work by that new user id. Device-local
  playlists may be adopted by the current account; records owned by another user
  are never uploaded to it.
- A same-id local record owned by another account is never overwritten or deleted
  by a remote pull or acknowledgement; only the current owner's outbox may be
  cleared.
- Account deletion first calls the server RPC. On success, records owned by that
  account are retained locally as device-only playlists with cloud metadata
  removed, and its outbox entries are deleted. A confirmed deletion leaves a
  local recovery marker until this cleanup succeeds. Other accounts' records are
  untouched.

## Service Worker Boundary

The Worker routes requests containing an `Authorization` header and known
Supabase `/auth/v1/`, `/rest/v1/`, `/functions/v1/`, and `/realtime/v1/` paths
directly to the network before any cache lookup. It precaches the public config,
cloud module, and vendored SDK so the local account UI can render offline without
caching any session or user-data response.

## Compatibility And Rollback

- v5 is an additive IndexedDB upgrade; v4 queue/playlists/caches remain valid.
- Once v5 opens, rollback must preserve `DB_VERSION >= 5`. The existing rollback
  guard and README version wording must advance together.
- Disabling or clearing cloud public configuration immediately returns to local
  mode without deleting local data.
- No real cloud resource, remote push, or Pages deployment is part of the local
  implementation milestone.

## Verification Strategy

- Unit: config validation, remote-record validation, merge decisions, conflict
  classification, and API-key exclusion.
- Browser desktop/mobile: unconfigured local mode; sign-up/sign-in/recovery;
  persisted session; local upload and remote download; offline pending/reconnect;
  conflict choices; sign-out owner isolation; account deletion local retention.
- Service Worker: authenticated/cloud GET responses are never read from or written
  to CacheStorage.
- Static/schema: exact pinned SDK, public-only config, RLS enabled, per-user
  policies, optimistic RPCs, account-delete restriction, v5 rollback contract.
- Full `npm run verify` from the exact Pages artifact before any commit.
