# Ref ownership and look serialization coverage

`native/macos/ref_look_tests.swift` links the unchanged production `AXRefStore` and
`LookNode` through `coverage:swift`. Fixtures construct two self-process application
handles and one handle for a managed non-GUI child PID, then compare CF identity,
without AX attribute queries, TCC, windows, capture, input, app activation or clipboard
access. Look fixtures use `element: nil`.

The child is `/bin/cat` reading an owned stdin pipe, with stdout/stderr sent to the
null device. After constructing the handle, the fixture closes the pipe and calls
`waitUntilExit()` BEFORE any assertion can call `exit(1)`. The successful child exit
and reaped state are asserted; subsequent ref operations only use inert handles.
Launch failure fails the suite before constructing the other-PID handle. No unrelated
application PID is discovered, queried or acted upon.

`test/ref-look-safety.test.mjs` audits direct `AX*` call sites in the actual Swift
fixture and the two complete production types: only handle construction is allowed
in the fixture, with no AX calls in either production type. This is explicitly a
source-level regression guard, not runtime interposition. No AX dependency injection
exists in these types; adding one or platform symbol interposition solely for these
bookkeeping tests would expand the runtime/build scope. The only other CF operation
on handles is identity comparison.

Local measurement against `c00e4196` (baseline: the hosted #765 LLVM artifact):

| `bridge.swift` metric | Before uncovered / total | After uncovered / total |
| --- | --- | --- |
| LLVM lines | 4810 / 5149 | 4751 / 5149 |
| LLVM functions | 705 / 786 | 701 / 786 |
| LLVM regions | 2250 / 2464 | 2232 / 2464 |
| LCOV line records | 3824 / 4111 | 3766 / 4111 |
| LCOV function records | 716 / 797 | 712 / 797 |

Swift LLVM regions are not branch outcomes or statements; B/S are not measured.
All other production Swift file totals and uncovered counts are unchanged. No
policy caps are changed from local evidence. Hosted exact-HEAD artifacts remain
required before tightening the selected host's ratchet.

Target records in `coverage/swift/llvm.json`:

| Function / source location | Before calls; uncovered regions | After calls; uncovered regions |
| --- | --- | --- |
| `AXRefStore.storeWindow`, 76:52-88:3 | 3; 1/6 | 8; 0/6 |
| `AXRefStore.transferElements`, 112:50-118:3 | 1; 2/5 | 4; 0/5 |
| `AXRefStore.window`, 139:47-143:3 | 0; 1/1 | 6; 0/1 |
| `LookNode.init`, 603:380-627:3 | 0; 1/1 | 3; 0/1 |
| `LookNode.payload`, 629:34-656:3 | 0; 12/12 | 8; 0/12 |
| `LookNode.payload` child closure, 647:29-647:45 | 0; 1/1 | 3; 0/1 |

The transfer early returns at 113:25-113:35 and 116:64-116:74 now each execute
once. All payload optional-field regions execute, alongside empty/false cases
that assert the keys are absent. Expected dictionaries assert every base value,
including alternating capabilities, nonintegral/negative rectangles, child order
and recursive serialization. FIFO checks exercise below/at/above capacity and
zero capacity, checking both refs and snapshots while preserving owned refs.

The previously missed `storeWindow` 82:5-83:4 unequal-handle fallthrough now
executes with the owned child handle. Both refs are asserted distinct, resolve to
their exact original handles and deduplicate independently. The owner approved
synthetic other-PID handle construction without queries; no production source,
denominator, exemption or coverage policy was changed. All selected functions and
regions are covered locally; exact-HEAD hosted confirmation remains separate.

Mutation evidence (each compiled the real mutated source and failed the native
suite, then the original source was restored and the scoped suite passed):

- Compare each stored handle with itself instead of the supplied handle: `FAIL: unequal window handle receives a distinct ref`.
- Replace destination append with assignment: `FAIL: successor eviction removes original destination refs`.
- Write `offscreen: false` when enabled: `FAIL: nested payload serializes every optional field and capability exactly`.
- Reverse serialized children: `FAIL: recursive payload preserves child order`.

These controls are carried in `scripts/check-sync-reverts.mjs`; assertions live
in a separate Swift file. The producer still compiles once with `swiftc -j 1`,
keeps every shipped Swift file in its denominator and rejects foreign profiles.
