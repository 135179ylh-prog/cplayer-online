# Implementation - Storage resilience

1. Add the safe localStorage/storage-health boundary and migrate every production
   localStorage call through it.
2. Upgrade IndexedDB to version 4, add image timestamp indexing, single-flight
   open, blocked handling, stale-connection closure, and transaction completion.
3. Make the queue record authoritative, add transactional revision comparison,
   and add one quota-prune retry for critical user-data writes.
4. Add bounded normal/aggressive pruning for images and remote playlist records;
   keep optional cache failures separate from successful network/UI work.
5. Make Service Worker dynamic API requests network-only, scope cache reads to the
   current cache, and advance the cache revision.
6. Add focused Playwright regressions for denied/blocked/stale storage, queue
   conflict and retry, cache bounds, optional-cache failure, and Service Worker
   isolation. Update static contracts without adding tautological test switches.
7. Run focused tests, then `npm run verify` on a free local port; record exact
   counts, viewport coverage, audit and whitespace evidence.
8. Commit locally, archive the task, and record the Trellis journal. Do not push
   or deploy.
