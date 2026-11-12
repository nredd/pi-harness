# Ref ownership and look serialization coverage

`native/macos/ref_look_tests.swift` links the unchanged production `AXRefStore` and
`LookNode` through `coverage:swift`. Fixtures construct two self-process application
handles and compare CF identity, without AX attribute queries, TCC, windows, capture,
input, app activation or clipboard access. Look fixtures use `element: nil`.

Local measurement against `c00e4196` (baseline: the hosted #765 LLVM artifact):

| `bridge.swift` metric | Before uncovered / total | After uncovered / total |
| --- | --- | --- |
| LLVM lines | 4810 / 5149 | 4751 / 5149 |
| LLVM functions | 705 / 786 | 701 / 786 |
| LLVM regions | 2250 / 2464 | 2233 / 2464 |
| LCOV line records | 3824 / 4111 | 3766 / 4111 |
| LCOV function records | 716 / 797 | 712 / 797 |

Swift LLVM regions are not branch outcomes or statements; B/S are not measured.
All other production Swift file totals and uncovered counts are unchanged. No
policy caps are changed from local evidence. Hosted exact-HEAD artifacts remain
required before tightening the selected host's ratchet.

Target records in `coverage/swift/llvm.json`:

| Function / source location | Before calls; uncovered regions | After calls; uncovered regions |
| --- | --- | --- |
| `AXRefStore.storeWindow`, 76:52-88:3 | 3; 1/6 | 6; 1/6 |
| `AXRefStore.transferElements`, 112:50-118:3 | 1; 2/5 | 4; 0/5 |
| `AXRefStore.window`, 139:47-143:3 | 0; 1/1 | 5; 0/1 |
| `LookNode.init`, 603:380-627:3 | 0; 1/1 | 3; 0/1 |
| `LookNode.payload`, 629:34-656:3 | 0; 12/12 | 8; 0/12 |
| `LookNode.payload` child closure, 647:29-647:45 | 0; 1/1 | 3; 0/1 |

The transfer early returns at 113:25-113:35 and 116:64-116:74 now each execute
once. All payload optional-field regions execute, alongside empty/false cases
that assert the keys are absent. Expected dictionaries assert every base value,
including alternating capabilities, nonintegral/negative rectangles, child order
and recursive serialization. FIFO checks exercise below/at/above capacity and
zero capacity, checking both refs and snapshots while preserving owned refs.

Residual: `storeWindow` 82:5-83:4 is a *reachable* unequal-handle fallthrough,
not a compiler-generated or structural exemption. Two application handles for
the same PID compare equal, so this fixture cannot exercise that path while
obeying #769's self-process-application-handle-only constraint. A second distinct
AX element or synthetic other-PID handle would broaden that constraint. No live
query, copied implementation, source rewrite, exclusion or fake hit is used to
hide the residual. This slice does not satisfy #769's zero-region requirement
for that path and must not be reported as whole-issue completion.

Mutation evidence (each compiled the real mutated source and failed the native
suite, then the original source was restored and the scoped suite passed):

- Replace destination append with assignment: `FAIL: successor eviction removes original destination refs`.
- Write `offscreen: false` when enabled: `FAIL: nested payload serializes every optional field and capability exactly`.
- Reverse serialized children: `FAIL: recursive payload preserves child order`.

These controls are carried in `scripts/check-sync-reverts.mjs`; assertions live
in a separate Swift file. The producer still compiles once with `swiftc -j 1`,
keeps every shipped Swift file in its denominator and rejects foreign profiles.
