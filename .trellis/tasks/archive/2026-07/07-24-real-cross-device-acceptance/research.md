# Research - 真实跨设备验收

## Baseline

- `main` / `origin/main`: `968ec48` before task creation.
- Status-center feature: `c0d1408`; archived release evidence under
  `archive/2026-07/07-24-sync-status-center/`.
- Latest Pages run before this task: `30032507265`, quality/deploy success.
- Live desktop profile previously restored the real authenticated account and
  reported `synced`, pending `0`, conflicts `0`; credentials were not inspected.

## What Automation Already Proves

- 24/24 desktop/mobile account cases cover upload, download, offline recovery,
  conflict choice, session restore, foreign-owner isolation, tombstone deletion,
  account deletion retention, counts, last success, and error retry.
- The mock owns only the HTTP boundary and cannot prove the real Supabase project,
  RLS, email session, physical phone storage, mobile network transition, or actual
  GitHub Pages cache lifecycle. Those are this milestone's evidence gap.

## Expected Manual Boundary

Codex can operate a temporary desktop Chrome tab through the existing authenticated
profile. The physical phone is outside that browser session, so the user must make
the phone-side actions. This is deliberate evidence of two independent storages,
not a limitation to bypass with a second automated context.
