# Bug Analysis: remote-only trash hidden after upgrade

### 1. Root Cause Category

- **Category**: C - Change Propagation Failure
- **Specific Cause**: The trash milestone changed deletion from local hard delete
  to recoverable state, but `decidePlaylistSync` retained the older rule that a
  remote tombstone is ignored when the local record is absent. A device upgraded
  after the old client had already removed its local row therefore reported
  `synced` while hiding recoverable cloud content.

### 2. Why Fixes Failed

No product fix preceded the root-cause finding. Existing tests passed because
their tombstone case always seeded the local active record before remote delete;
they did not model the persistent state left by a pre-trash client.

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Decision matrix | Pull remote trash when both local record and owner outbox are absent. | DONE |
| P0 | Data-loss guard | Keep a surviving upsert/restore outbox pending when its local record is missing. | DONE |
| P0 | Unit regression | Cover local-null tombstone with and without an outbox. | DONE |
| P0 | Browser regression | Start with remote-only trash, download it on desktop/mobile, render it, and restore it. | DONE |
| P1 | Cache propagation | Bump the Service Worker and update the exact static cache-version contract in the same change. | DONE |
| P1 | Live upgrade evidence | Confirm the preserved 2026-07-24 cloud tombstone appears after v66 deployment. | TODO |

### 4. Systematic Expansion

- **Similar Issues**: Remote active rows already pull when local is absent.
  Remote purge markers may stay absent on a clean new device because they have no
  recoverable content; a device that still has local content receives the marker
  and follows the existing recover-copy/pull-purge rules.
- **Design Improvement**: Treat `local === null` as a real synchronization state,
  not as an automatic no-op. Evaluate it together with remote lifecycle state and
  durable outbox ownership.
- **Process Improvement**: Cross-device acceptance for a lifecycle migration must
  include the state produced by the immediately previous production client, not
  only two devices already running the new schema and behavior.

### 5. Knowledge Capture

- [x] Updated the trash/history design and frontend quality contract.
- [x] Added red-to-green unit and desktop/mobile browser evidence.
- [x] Passed the complete local release gate from the final Pages artifact.
- [ ] Record Actions and live production convergence evidence.
