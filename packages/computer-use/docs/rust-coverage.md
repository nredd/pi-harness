# Rust coverage (report-only)

The native bridge crates retain their normal tests. Native Ubuntu CI additionally runs
`coverage:rust` in the computer-use shard with Rust `1.97.1`, matching `llvm-tools-preview`,
cargo-llvm-cov `0.9.1` and two build jobs. `computer-use-linux-native/primary` consumes its raw LLVM
JSON, report-only and excluded from the global target pending #696. A failed test, instrumentation
error, missing/empty/malformed report or missing executable source map fails the selected-host gate.
macOS, Windows-hosted WSL and native ARM64 WSL-replacement cells report this signal NOT RUN.
They do not borrow Ubuntu counters. This is not a Windows-native producer.

All report commands disable cargo-llvm-cov's default filename exclusions. Accounting structurally
scopes the complete `native/linux/bridge-rs/src/**/*.rs` inventory, including separately named
`cfg(test)` source modules, and normalizes hosted absolute paths to package-relative paths.
Conventional `tests/` integration source and dependencies are outside that production scope.
A missing source map is accepted only for a conservatively validated module/re-export-only file
(such as `lib.rs`), recorded as zero executable units, not fabricated executable lines.
Inline and separately named source test functions are included in LLVM counters. Passing them can
inflate apparent runtime coverage, so neither their hits nor this producer establish runtime 100%.
Regions remain LLVM regions, NEVER branches. LLVM's absent branch/statement data is unmeasured,
not a zero-branch/zero-statement success. Raw LCOV remains available for inspection; accounting
uses LLVM JSON because LCOV's absent `BRDA` records cannot express native regions.

## Pinned installation and execution

From the repository root (requires Node, Cargo and rustup; never invokes helper setup or GUI tools):

```sh
rustup toolchain install 1.97.1 --profile minimal --component llvm-tools-preview
cargo +1.97.1 install cargo-llvm-cov --version 0.9.1 --locked
# Important when Homebrew also supplies cargo/rustc: put the matching toolchain FIRST.
export PATH="$(dirname "$(rustup which --toolchain 1.97.1 cargo)"):$PATH"
CARGO_BUILD_JOBS=2 npm run coverage:rust --workspace @nredd/pi-computer-use -- --crate linux
```

On a native Windows runner, use the same versions and select the rustup toolchain's bin directory
in PowerShell before running the Windows crate:

```powershell
rustup toolchain install 1.97.1 --profile minimal --component llvm-tools-preview
cargo +1.97.1 install cargo-llvm-cov --version 0.9.1 --locked
$env:Path = "$(Split-Path (rustup which --toolchain 1.97.1 cargo));$env:Path"
$env:CARGO_BUILD_JOBS = '2'
npm run coverage:rust --workspace '@nredd/pi-computer-use' -- --crate windows
```

Cargo's bin directory (normally `~/.cargo/bin`, or `$CARGO_HOME/bin`) must also be on PATH for
`cargo-llvm-cov`. The script checks its exact `0.9.1` version and never installs tools automatically.
Do not mix a Homebrew rustc sysroot with rustup's LLVM tools. The first local attempt demonstrated
this failure (`failed to find llvm-tools-preview`); the explicit PATH above fixed it.

Arguments: `--crate linux|windows`, `--output directory`. Paths with spaces are passed as argv,
not shell code. Without `--output`, reports go to an OS temp directory. With it, a fresh unique
per-crate subdirectory is created there; existing outputs are never cleaned or reused. Prefer a
temp directory, not the source tree. Each run gets its own `CARGO_TARGET_DIR` and tests once with
`--locked --no-report`, then renders `lcov.info`, `summary.txt` (per-file lines/functions/regions),
`coverage.json` (LLVM detail), `run.log`, `commands.log` and `metadata.json` (host and elapsed time).
Collect the whole printed directory for review. The logs include test counts and test runtime;
metadata time includes build, tests and all report formats. Compiler output is retained, not
replaced with an invented test count. Doc tests run normally but are not separately instrumented.
The output parent also contains a stable `coverage.json` accounting entry, published only after
report validation; raw reports/logs remain under the unique run directory. CI uploads these files,
not instrumented build products. `setup.log` records pinned-tool setup runtime; `metadata.json`
records build/test/report runtime. A second uninstrumented test build remains in the existing
packed-source/diagnostics contract, deliberately not replaced by coverage instrumentation.

## Measured baseline

2026-10-28, Apple Silicon macOS, native sources at harness `0143b72` (coverage tooling added in
this PR), Rust `1.97.1`, cargo-llvm-cov `0.9.1`, two build jobs, fresh instrumented target.
Output: `/tmp/cu-rust-coverage-real/linux-IMm2XX`. Build: 30.49s. End-to-end: **32.007s**.
Tests: library 18 passed/1 ignored (0.00s), binary 12 passed (0.00s), protocol integration 3 passed
(0.24s): **33 passed, 1 ignored, 0 failures**. The ignored case needs a live AT-SPI bus.

Counts below are covered/total, followed by percentage. These are the actual LLVM text/JSON
reports, including instrumented test functions. `lib.rs` has no executable regions and is not
listed by LLVM. No files were filtered to improve the denominator.

| Linux crate file | Lines | Functions | Regions |
| --- | --- | --- | --- |
| `src/atspi.rs` | 271/558 (48.57%) | 29/62 (46.77%) | 326/838 (38.90%) |
| `src/error.rs` | 6/18 (33.33%) | 1/5 (20.00%) | 4/24 (16.67%) |
| `src/main.rs` | 427/970 (44.02%) | 40/100 (40.00%) | 620/1634 (37.94%) |
| `src/protocol.rs` | 18/18 (100.00%) | 2/2 (100.00%) | 10/10 (100.00%) |
| `src/state.rs` | 201/243 (82.72%) | 24/35 (68.57%) | 370/433 (85.45%) |
| `src/wayland.rs` | 4/43 (9.30%) | 1/6 (16.67%) | 6/64 (9.38%) |
| `src/x11.rs` | 236/759 (31.09%) | 28/85 (32.94%) | 345/1312 (26.30%) |
| **Linux total** | **1163/2609 (44.58%)** | **125/295 (42.37%)** | **1681/4315 (38.96%)** |
| **Windows total/per-file** | NOT RUN | NOT RUN | NOT RUN |

This is a macOS-hosted Linux-crate baseline, NOT Linux desktop acceptance. It exercises portable
protocol/state and error paths; Linux-cfg code, actual AT-SPI/X11/Wayland sessions, permissions and
input delivery remain unverified. Windows coverage cannot run on macOS/Linux; the script rejects
that request rather than presenting portable stubs as Windows coverage. Windows counts/runtime
are unknown. The existing WSL job is a Linux runtime, not a Windows-native crate test job.

Native Ubuntu's new hosted baseline and setup/producer runtime are pending the first #758 CI
receipt. The historical macOS table above is NOT its floor. Native artifacts preserve raw per-file
lines/functions/regions, setup/run/command logs and elapsed metadata. No Windows-native runtime,
actual AT-SPI/X11/Wayland desktop behavior, focus, physical input or display acceptance is claimed.
Narrow documented live-adapter limitations remain; ordinary platform policy/error paths are not
blanket exemptions. #696 retains deterministic runtime seam closure and the Windows producer.
