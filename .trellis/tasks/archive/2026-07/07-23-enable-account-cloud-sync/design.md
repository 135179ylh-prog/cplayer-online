# Design - Enable production account cloud sync

## Production Boundary

The GitHub Pages artifact remains a public static application. Production cloud
configuration contains only the Supabase project HTTPS URL and its publishable
browser key. Database authorization is enforced by Row Level Security and RPC
functions; no privileged credential is shipped to the browser.

```text
GitHub Pages
  -> js/cloud-config.js (public URL + publishable key)
  -> Supabase Auth
  -> RLS-protected playlist RPC
  -> public.cplayer_playlists
```

## Supabase Changes

- Run the checked-in additive migration
  `supabase/migrations/202607230001_account_cloud_sync.sql` in the selected Free
  project only after an explicit pre-submit confirmation.
- Configure the Site URL as the Pages root and allow the Pages `index.html`
  recovery redirect.
- Keep email/password authentication on the provider defaults. Users register
  their own player accounts; this task creates no real test users.
- Validate the migration by inspecting the created table, RLS state, policies,
  functions, and grants without reading any secret key.

## Repository Changes

- Fill `js/cloud-config.js` through its existing public configuration boundary.
- Increment the Service Worker cache version because the config is precached.
- Replace the old “configuration must be empty” release assertions with exact
  validation of an HTTPS project URL, a publishable/anon browser key, and the
  continued absence of service-role/secret/admin credentials.
- Update release-artifact tests, README setup/status text, and the frontend cloud
  contract so documentation and executable checks describe production mode.

## Verification And Release

Run the full local gate on an unused Playwright port. Commit only after the gate
passes. Push `main` to trigger Pages, monitor the workflow, then load the public
site and verify that the account controls are enabled while the visitor remains
signed out.

## Rollback

If production cloud access misbehaves, clear the two public values in
`js/cloud-config.js`, bump the Service Worker cache version again, verify, and
deploy that forward fix. This returns the UI to local-only mode without deleting
browser playlists. The additive Supabase schema may remain in place; do not roll
the browser database below IndexedDB v5.
