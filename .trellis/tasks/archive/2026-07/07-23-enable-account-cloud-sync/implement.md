# Implementation Plan - Enable production account cloud sync

1. [x] Restore the Trellis task context, review the prior account-sync artifacts,
   and load the frontend/database/release contracts.
2. [x] Review the checked-in SQL migration, prepare it in Supabase SQL Editor,
   obtain explicit confirmation, execute it, and inspect its resulting objects.
3. [x] Configure Supabase Authentication Site URL and recovery Redirect URL for
   the production GitHub Pages address.
4. [x] Add the public production project URL/key, bump the Service Worker cache,
   and update static/artifact tests, README, and quality contracts together.
5. [x] Run focused checks and then a fresh full `npm run verify` on an unused port;
   fix any failure and record exact evidence.
6. [x] Review the diff for accidental credentials, commit the activation change,
   push `main`, and monitor the Pages workflow to completion.
7. [x] Run the production smoke check, update verification/rollback notes, and
   close the task. Deterministic browser tests retain the signed-out fallback;
   the live browser restored the user's real session and reported `synced`.

## Risk Points

- SQL execution changes a real external database and therefore requires a final
  confirmation immediately before Run.
- `js/cloud-config.js` is public by design; only a publishable/anon key is valid.
- A precached configuration change without a cache bump can leave old clients in
  disabled mode.
- Static tests that still require an empty config would incorrectly block release;
  weakening them without a positive secret-key rejection would create a leak risk.
- Pushing `main` deploys immediately, so the complete local gate must pass first.

## Validation Commands

```powershell
npm test
npm run check:sw
npm run check:features
npx playwright test tests/e2e/release-artifact.spec.mjs
$env:PW_PORT='<unused-port>'; npm run verify
gh run list --workflow pages.yml --limit 5
```
