# Implementation - Final release preflight

1. Add one guarded, cross-platform Pages artifact builder and package command.
2. Make the deterministic test server accept an artifact root while preserving
   controlled test-only routes.
3. Run the full release browser suite against the built artifact and add public
   asset/private-path smoke coverage.
4. Move Pages artifact upload into the quality job and remove the shell copy
   implementation from the deploy job.
5. Add staged/untracked repository checks and a read-only DB-version rollback
   target guard with unit tests.
6. Align Node metadata/docs, update static contracts, and add the release
   artifact contract to the frontend quality spec.
7. Run focused script/unit/browser checks, incompatible and compatible rollback
   probes, then the full quality gate on a free port.
8. Record current release notes, counts, schema/cache versions, device/manual
   limits, and safe rollback steps. Commit locally, archive, and journal without
   push or deployment.
