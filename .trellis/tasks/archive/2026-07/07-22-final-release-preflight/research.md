# Research - Final release preflight

## Current evidence

- Before this task, `npm run verify` passed eight layers and reported 11 unit
  tests plus 124 browser cases (122 passed, two intentional skips).
- Playwright serves the repository root through `tests/e2e/server.mjs`.
- Pages independently stages five files and five directories with an Ubuntu
  shell `cp` block, then uploads that temporary directory in another job.
- Existing static checks assert strings in the workflow but never build or boot
  the resulting directory.
- The old release candidate notes cache v57, 82 cases, and no IndexedDB
  migration. Current production uses `cplayer5-v59-storage-resilience` and
  `CPlayer5DB` v4.
- The storage contract explicitly states that a rollback must continue opening
  v4. A v3 build against an existing v4 database receives `VersionError`.
- The previous task exposed a quality-gate blind spot: untracked task files with
  extra EOF blank lines were invisible to `git diff --check`.
- README says Node 18+, the current quality script uses `import.meta.dirname`,
  and CI installs Node 22.

## Decisions

- Test the complete release suite from the deployment directory, not only a
  small duplicate smoke configuration.
- Keep the test fixture/API exceptions in the deterministic server; never copy
  them into the deployable directory.
- Upload the tested artifact across the quality/deploy job boundary instead of
  rebuilding it.
- Keep release identity meanings separate; fix the unsafe DB rollback contract
  without forcing the UI badge, cache revision, and schema number to match.
- Record physical-device and remote deployment checks as unexecuted rather than
  weakening deterministic local gates with live dependencies.
- Parse rollback sources with Acorn/parse5 and aggregate both current and target
  deployed HTML plus loaded/residual JS/MJS. Resolve external scripts from each
  HTML file's directory. A first-found version is unsafe because a stale v4
  declaration can hide a real v3 path.
- Treat HTML event handlers, `javascript:` URLs, global-object aliases, and
  unknown database-shaped `.open(name, version)` wrappers as executable or
  unresolved input. The rollback guard is intentionally fail closed.
- Preserve browser ordering across classic scripts; a later lexical declaration
  does not exist while an earlier script executes. Parser-blocking, defer, async,
  and child-document scopes differ. Reject runtime code generation/capability
  escape and keep prototype-sensitive destructuring defaults unknown.
- Treat writes from async/module/handler and uncertain control flow as sticky
  instability on their classic global source binding. This preserves the
  dependency through later aliases and database-name constants without guessing
  which scheduled script wins.
- Interpret unattached `.js` as both classic and module when possible. This closes
  the Worker/Service Worker ambiguity while HTML-loaded scripts keep their
  declared execution mode.

## Rollback guard bug analysis

### Root cause category

- **D - Test coverage gap** and **E - implicit assumption**. Early extraction
  assumed `<script>` plus the first recognizable v4 represented the whole
  executable tree. Browsers can reach the same database through other HTML
  execution surfaces, aliases, helpers, entry points, and residual modules.

### Why earlier fixes were incomplete

- Each fix closed one syntax form while the model still asked "can I find v4?"
  instead of "can any deployed path open an older or unknown version?"
- Concatenating classic scripts modeled parser convenience, not browser execution
  order; folding destructuring defaults assumed clean built-in prototypes.
- Treating the last AST assignment as authoritative ignored update expressions,
  uncertain branches/loops, destructuring writes, and nested-function side effects.
- Modeling every declaration as block-scoped missed `var` writes, while scanning
  only `js/` missed imported modules in other Pages directories. Both boundaries
  now derive from language scope and the builder's shared artifact allowlist.
- Current-tree and target-ref discovery initially used different scopes, so a
  complete target scan could still compare against an incomplete current floor.

### Prevention mechanisms

| Priority | Mechanism | Action | Status |
| --- | --- | --- | --- |
| P0 | Architecture | One parser and one merge rule own current and target extraction. | Done |
| P0 | Test coverage | Adversarial tests cover decoys, HTML handlers/URLs, aliases, dynamic helpers, and residual JS/MJS. | Done |
| P1 | Documentation | Release spec lists accepted static forms and fail-closed boundaries. | Done |
| P1 | Review | Re-run hostile read-only review after parser changes, then run the staged full gate. | Done |

### Systematic expansion

- The same principle applies to artifact allowlists and repository checks: scan
  the complete deployed/staged boundary rather than the first familiar file.
- Future support for imports or interprocedural wrappers must add parser behavior,
  ambiguity handling, and red/green tests together; it must not silently assume
  a default version.
