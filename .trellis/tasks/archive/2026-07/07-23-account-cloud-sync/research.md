# Research - Account and cloud sync

## Repository Findings

- The site is a static GitHub Pages artifact; it has no production backend.
- Before this task browser-owned data used `CPlayer5DB` v4 and safe localStorage
  helpers; the implementation upgrades it additively to v5.
- `current_queue` and `user_pl_*` share the `playlists` object store. Only
  `user_pl_*` records belong in cloud sync; remote playlists, images, lyrics,
  queue, recent history, playback state, sleep timer, and API credentials do not.
- User-playlist create, song add, detail mutation, and normal delete converge on
  the playlist persistence functions. Backup import has one separate atomic batch
  path that must also enqueue sync work.
- The app-ready signal fires after local restore. Cloud initialization can start
  after that signal without changing startup readiness.

## Provider Decision

Supabase Auth + Postgres is the minimum-disruption fit for a public static app:
the browser may hold the public project URL/key, while Row Level Security owns
authorization at the database. Firebase is viable but would introduce a different
rules/data model; a custom Worker/API would add a second server deployment and
secret-bearing backend.

Official pricing checked on 2026-07-23:

- Free plan: $0/month, 500 MB database, 50,000 monthly active auth users, and
  5 GB egress.
- Free projects may pause after one week of inactivity.
- Free-plan overage leads to notification/restriction unless the owner explicitly
  upgrades; the implementation does not enable a paid plan or add-on.

Sources:

- https://supabase.com/pricing
- https://supabase.com/docs/guides/platform/billing-faq

## Security Conclusions

- A static site cannot hide any value shipped to the browser. Only the Supabase
  publishable/anon key is valid client configuration.
- Service-role keys and OAuth client secrets require a server boundary and are
  forbidden in source, build output, browser storage, tests, and documentation.
- Authentication tokens are browser session material, not music API keys. The
  Service Worker must never cache authorized user-data responses.
- RLS and optimistic server versions are release blockers; client-side filtering
  alone cannot protect another user's rows.
