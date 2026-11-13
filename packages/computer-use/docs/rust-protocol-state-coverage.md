# Linux protocol/state/error coverage slice

Issue #801 adds eight dedicated Cargo integration tests in
`native/linux/bridge-rs/tests/protocol_state_errors.rs`. They call the shipped implementations,
not copies or test-only substitutes. `src/protocol.rs`, `src/state.rs` and `src/error.rs` are
unchanged from the MIT upstream import `f2239e44` and the native Ubuntu reference source
`3d97e8962b9ebb32a2b084b3a421875571ed90cf`.

Contracts:
- Reject malformed JSON, missing fields, wrong scalar types, duplicate fields and invalid unsigned versions.
  Deserialization still accepts unknown commands and versions; dispatch owns negotiation/refusal.
  A bounded real-helper NDJSON test checks malformed envelopes, version mismatch, unknown-command
  errors and EOF draining without invoking backend commands; the child is reaped before assertions.
- Preserve escaped response IDs, explicit null success results, omitted opposite payloads, every stable
  error code and the real error `Display` implementations.
- Retain stable sorted roots, remove dead roots without reusing their refs, clamp image sizes,
  preserve base snapshots, resolve the newest scope owner and reject wrong/missing/expired ownership.
- Generate distinct state IDs across threads without assuming a globally fixed starting number.

No production guard, coverage filter, cap, pin or version changes. No live bus, desktop, privileged
input, Windows-native execution or ARM64 qualification. #696 remains open for all other native work.
`test/rust-protocol-state-registration.test.mjs` and its drop control protect Cargo discovery only;
they are source wiring, NOT Rust runtime coverage. Cargo executes the actual assertions, and the
existing real-source LLVM producer measures them.

## Reproduce

Use the pinned toolchain setup in [here](rust-coverage.md), then from the repository root:

```sh
CARGO_BUILD_JOBS=1 npm run coverage:rust --workspace @nredd/pi-computer-use -- --crate linux --output /tmp/issue-801-coverage
cargo fmt --manifest-path packages/computer-use/native/linux/bridge-rs/Cargo.toml --check
CARGO_BUILD_JOBS=1 cargo clippy --locked --manifest-path packages/computer-use/native/linux/bridge-rs/Cargo.toml --all-targets -- -D warnings
```

Use the same command on the base without the new tests for the before report. Every producer run
uses a fresh isolated target and preserves JSON, LCOV, text summary, commands, metadata and logs.
CI's existing native Ubuntu artifact is the native authority; macOS measurements below are portable
Linux-crate execution, not a native Ubuntu result. Missing native output still fails closed through
#758's accounting gate. Branches and statements are UNMEASURED; LLVM regions are not branches.

## Source identity and baseline

SHA-256 of unchanged runtime sources, in both before and after:

| Source | SHA-256 |
| --- | --- |
| `src/protocol.rs` | `5fc04cf91bd7b57085198b5239d922e9f72e57acfda14bd52c9ca15253b18459` |
| `src/state.rs` | `b09771a3f0a81cc2cab6d9806fed42204edcfb19ec8e23b4b67a5787ddf9f5bc` |
| `src/error.rs` | `d553ca07226c8193ce777ed6dec2dd478cbc6b8b3f8f6787889e6bdf54fcef39` |

Native before: Ubuntu run `43214341839`, artifact `13943427896`, source
`3d97e8962b9ebb32a2b084b3a421875571ed90cf`. Its raw source mappings and summaries were retrieved
and compared with the unchanged source inventory before this change. See [here](rust-coverage.md)
for artifact hashes and the native producer receipt. Source-scoped uncovered/total L/F/regions:

| Source | Native Ubuntu before | macOS before | macOS after |
| --- | --- | --- | --- |
| `src/protocol.rs` | `0/18, 0/2, 0/10` | `0/18, 0/2, 0/10` | `0/18, 0/2, 0/10` |
| `src/state.rs` | `42/243, 11/35, 63/433` | `42/243, 11/35, 63/433` | `0/243, 0/35, 1/433` |
| `src/error.rs` | `12/18, 4/5, 20/24` | `12/18, 4/5, 20/24` | `1/18, 1/5, 2/24` |

Local runs: Rust `1.97.1`, cargo-llvm-cov `0.9.1`, one Cargo job, fresh target each time,
base `aafa421d`. Before: **33 passed, 1 ignored**, **63.999s** build/test/report.
After: **41 passed, 1 ignored**, **47.787s**. The ignored AT-SPI test requires a live bus.
The new tests are conventional integration sources outside the production inventory, so they add
no source denominator. Existing inline tests remain in the measured denominator; this does not
establish native runtime 100%. Exact-HEAD Ubuntu after evidence belongs to the PR's hosted artifact,
not these local measurements.

A disposable crate copy with two deliberate mutations (remove the code from error display; return
`InternalError` for a stale element) failed the corresponding two real Cargo tests, **5 passed,
2 failed**, exit `101`. The final unmodified suite passed **8/8**; the crate passed **41 tests**.
Those native mutation checks are separate from the source-registration drop control.

Remaining uncovered regions are retained honestly: `state.rs` has the defensive empty `pop_front`
arm inside a loop already checking queue length; `error.rs` retains the serialization/string fallback
for an enum whose current variants always serialize as strings. No safety arm was deleted, made
public or corrupted solely to manufacture hits. No new exclusions classify these as covered.
