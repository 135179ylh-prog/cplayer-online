# Bug Analysis: CI animation timing boundary

### 1. Root Cause Category

- **Category**: E - Implicit Assumption
- **Specific Cause**: The browser test assumed a shared CI runner would always
  schedule at least four animation requests and executions inside a fixed 200ms
  window. The product contract is one live loop, not a minimum runner frame rate.

### 2. Why Fixes Failed

No speculative product fix was attempted. Re-running alone was rejected as a
solution because it would leave the timing assumption unchanged.

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
| --- | --- | --- | --- |
| P0 | Test architecture | Wait up to one second for four requested and executed frames before checking one-loop identity. | DONE |
| P0 | Negative-state coverage | Keep a fixed observation window only where the contract is zero recurring frames while paused or hidden. | DONE |
| P1 | Systematic expansion | Replace all positive fixed-window animation samples in the runtime suite, including reduced-motion resume. | DONE |
| P1 | Documentation | Record the positive-condition/negative-window rule in the frontend quality specification. | DONE |
| P1 | Delivery evidence | Re-run the complete local gate and GitHub Actions before deployment. | TODO |

### 4. Systematic Expansion

- **Similar Issues**: The runtime suite had four positive animation samples using
  the same fixed 200ms helper. All now share the bounded progress waiter. Other
  fixed waits found in the browser suite are negative observation windows or
  post-event quiet periods and were not mechanically changed.
- **Design Improvement**: Test behavior by observable state transitions and loop
  ownership, not by host frame rate.
- **Process Improvement**: When CI alone fails a short timing window, compare the
  asserted contract with the helper threshold and search the suite for every use
  of the same timing pattern before editing.

### 5. Knowledge Capture

- [x] Updated `.trellis/spec/frontend/quality-guidelines.md`.
- [x] Updated the active task research and verification evidence.
- [x] Confirmed this project has no `src/templates/markdown/spec/` mirror to sync.
- [ ] Record the successful replacement Actions run and final online acceptance.
