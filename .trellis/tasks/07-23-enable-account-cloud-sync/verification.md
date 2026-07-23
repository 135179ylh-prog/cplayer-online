# Verification - Enable production account cloud sync

## Environment

- Date: 2026-07-23 (Asia/Shanghai)
- Node.js 24.14.1, Python 3, Playwright Chromium
- Supabase project ref: `fgebuqieitvmxjiwjnbh`, Free plan, Singapore region
- Public Pages URL: `https://135179ylh-prog.github.io/cplayer-online/`
- Only the public project URL and publishable browser key were copied into the
  application. No secret/service-role/admin key was used or recorded.

## Real Supabase Evidence

The user explicitly confirmed the real project changes immediately before the
browser submit. SQL Editor executed
`supabase/migrations/202607230001_account_cloud_sync.sql` and reported
`Success. No rows returned`.

The post-migration read-only query returned:

| Check | Result |
| --- | --- |
| Table | `public.cplayer_playlists`, owner `postgres` |
| RLS | enabled `true`, forced `true` |
| Shape | 7 columns, 6 constraints |
| Policies | exactly 4 expected owner policies, all scoped to `authenticated` |
| Table grants | anon SELECT `false`; authenticated SELECT `true`; authenticated INSERT/UPDATE/DELETE all `false` |
| Column ACL | 0 custom column grants |
| RPCs | exactly 3; all `SECURITY DEFINER`; safe `pg_catalog, public` search path |
| RPC grants | anon execute `false`; authenticated execute `true` |
| Function owner | `postgres`, `BYPASSRLS=true`; account-delete owner can delete from `auth.users` |

Authentication URL Configuration was saved with:

- Site URL: `https://135179ylh-prog.github.io/cplayer-online/`
- Redirect URL: `https://135179ylh-prog.github.io/cplayer-online/index.html`

After each save the dashboard displayed the stored value and returned the save
button to its disabled/clean state. No real player account was created.

## Focused Local Evidence

| Command | Result |
| --- | --- |
| `npm test` | 33/33 unit tests passed |
| `npm run check:features` | passed; production public config and fallback contracts passed |
| `npm run check:sw` | passed |
| `npm run check:module` | passed |
| focused account + release-artifact Playwright on port 48766 | 26/26 passed across desktop 1280x800 and mobile 390x844 |
| `npm run build:pages` | 27 files, 18,547,591 bytes |

## Full Gate

`PW_PORT=48767 npm run verify` passed on 2026-07-23. All 10 layers completed:

- CSS and pinned Supabase vendor output were fresh.
- 33/33 unit tests passed.
- main module, Service Worker, and static feature contracts passed.
- dependency audit reported 0 vulnerabilities.
- Pages artifact contained 27 files totaling 18,547,591 bytes.
- browser regression ran 192 cases: 180 passed, 12 expected viewport skips,
  0 failed.
- repository text/whitespace checks passed.

## Pending Release Evidence

- Commit and `main` push: pending.
- GitHub Pages quality/deploy workflow: pending.
- Signed-out production smoke test: pending.

## Rollback

If the live account path fails, clear the two public values in
`js/cloud-config.js`, bump the Service Worker cache version, run
`npm run verify`, and deploy that forward fix. Local playlists remain intact.
Do not roll the browser database below IndexedDB v5. The additive Supabase table
may remain in place while the browser UI operates in local-only mode.
