# Design - Final release preflight

## Single artifact owner

`scripts/build-pages-artifact.mjs` owns the complete top-level deployment
allowlist. It validates the exact fixed `output/pages` path, removes only that
directory, copies the runtime files/directories byte-for-byte, then enumerates
the result for an auditable count.

```text
repository runtime files
        |
        v
build-pages-artifact.mjs
        |
        v
output/pages
   |           |
   v           v
Playwright   upload-pages-artifact
   |           |
   v           v
local proof  Pages deploy job
```

The workflow no longer owns a second shell `cp` list. The quality job uploads
the same directory after `npm run verify`; the deploy job consumes that uploaded
artifact without another checkout.

## Browser boundary

`PW_WEB_ROOT` selects the normal static root for `tests/e2e/server.mjs`. The
quality gate sets it to `output/pages`. Test-only controlled API responses and
the old Service Worker fixture remain explicit server routes backed by the
repository, so real PWA upgrade tests continue to work without placing fixtures
in the artifact.

The new artifact browser test verifies both sides of the boundary:

- required public resources return 200 and the app reaches ready;
- known repository-only resources return 404.

Existing offline/update tests then run against the artifact as part of the full
suite, proving that this is not only a static file-list check.

## Repository hygiene

`scripts/check-repository-state.mjs` composes three checks:

1. `git diff --check` for unstaged tracked changes;
2. `git diff --cached --check` for staged changes;
3. a UTF-8 byte scan for staged blobs (including file-type changes) plus
   unstaged/untracked source/task files.

The byte scan rejects BOM/non-UTF-8 input, trailing spaces, and more than one
final newline. It skips known binary extensions and ignored build/browser output.

## Rollback compatibility

`scripts/check-rollback-target.mjs` treats the current DB schema as the minimum
readable schema. It parses every deployable HTML file with parse5 and JavaScript
with Acorn, combines classic-script scope, inspects inline handlers, WHATWG-
normalized executable `javascript:` URLs and `srcdoc`, and scans loaded plus
residual runtime JS/MJS in both the current tree and target ref. External scripts
resolve relative to the owning HTML file. Each `srcdoc` has an independent
document scope.

Classic blocking and defer records retain browser order. A discovery pass marks
global bindings touched by async/module/handler or uncertain function/control-flow
writes as unstable before constants and aliases are evaluated; later reads then
remain unknown regardless of traversal order. A residual `.js` that is not tied to
an HTML script tag is checked as both classic script and module when both grammars
parse, while `.mjs` is module-only. Conflicting interpretations fail closed.

The extractor resolves conservative global aliases/constants and dynamic
capability symbols, then rejects unsupported, unresolved, or conflicting
CPlayer5DB versions before comparison. Unknown two-argument `.open` wrappers,
unresolved timer callbacks, runtime code generation, global mutation APIs,
document writes, `importScripts`, dynamic/external imports, and JavaScript
navigation fail closed. It never executes target code.

Imported constants and interprocedural wrapper parameters are intentionally not
evaluated. The canonical production DB open must remain statically recognizable;
otherwise the parser and its adversarial regression tests change together.
Missing destructured properties/indices also remain unknown because inherited
prototype values can replace a source-level default.
Straight-line local assignment is tracked, while updates, destructuring writes,
loop/branch writes, and nested-function side effects invalidate an outer binding
to unknown. Nested capability destructuring recursively preserves its marker.
`var` uses its real function/global scope; class static blocks own a separate var
scope. Global-object property writes update only matching classic global
`var`/function bindings, bypass lexical shadows, and destructuring/loop member
writes invalidate the real target. Mutable closure reads remain unknown. Residual
discovery imports the Pages builder's `PAGE_FILES`/`PAGE_DIRECTORIES`, so nested
HTML and JS/MJS under `img/` or any other deployed directory cannot escape
scanning and no second artifact allowlist is introduced.

Dynamic DOM synthesis of scripts, handler attributes, or `srcdoc` remains outside
the static analyzer. Production code must not introduce those mechanisms without
expanding this parser and its adversarial tests.

```text
current DB v4 + target DB v4/v5 -> compatible preflight
current DB v4 + target DB v3    -> reject; create a forward v4-compatible revert
```

This guard is read-only. It does not claim semantic migration compatibility;
the final browser gate still owns behavior validation.

## Supported runtime

Node.js 22 is the common baseline because CI already runs it and all local
scripts are ESM. `package.json` declares the engine and README explains the
expected failure when an older runtime is used.

## Rollback of this task

The artifact/checking scripts have no browser-data effects. Reverting them only
restores the old build pipeline. `js/app.js` remains DB v4, and any product
rollback after deployment must retain that version floor.
