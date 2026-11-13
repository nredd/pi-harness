# Rust coverage (report-only)

The native bridge crates retain their normal tests. Native Ubuntu CI additionally runs
`coverage:rust` in the computer-use shard with Rust `1.97.1`, matching `llvm-tools-preview`,
cargo-llvm-cov `0.9.1` and two build jobs. `computer-use-linux-native/primary` consumes its raw LLVM
JSON, report-only and excluded from the global target pending #696. A failed test, instrumentation
error, missing/empty/malformed report or missing executable source map fails the selected-host gate.
macOS and WSL guest cells, including native ARM64 WSL replacements, report this signal NOT RUN.
Accounting selects the CI guest value `wsl2`, not the Windows/native host class; Ubuntu's `linux`
guest still requires the report. They do not borrow Ubuntu counters.

The separate `computer-use Rust (windows-x64)` job runs on hosted `windows-2025`, independent
of the WSL guest and ARM64 runner routing. It verifies a native `x86_64-pc-windows-msvc` compiler,
checks rustfmt, compiles all targets, runs Clippy with warnings denied, builds warning-free docs,
and collects real Windows tests plus LLVM JSON/LCOV using the same pinned versions. It also
executes the opt-in Windows build/install routing suite against disposable destinations. The
required `owned (ubuntu-24.04)` fan-in rejects a failed, cancelled or missing Windows result
whenever its classified shards include computer-use; a docs-only or unrelated run does not
borrow a prior producer result. Missing/empty/wrong-crate reports fail the producer itself.
Raw Windows reports are retained as `computer-use-rust-windows-x64`; they are not injected into
Ubuntu's coverage signal or assigned invented per-file caps. Parent integration of Windows
policy/accounting remains separate from this raw producer. ARM64 qualification stays in #736.

Windows tests never enumerate the worker's windows or deliver physical input: root serialization
uses synthetic metadata, raw-input policy tests inject delivery after real preflight, and null
capture handles refuse before the capture API. This measures deterministic policy and refusal
code, not live UIA/capture/input acceptance. The crate's inline test code remains in LLVM's
source denominator; integration test sources remain distinguishable in raw reports. Unexecuted
Windows adapters are not exemptions or evidence of runtime 100%.

All report commands disable cargo-llvm-cov's default filename exclusions. Accounting structurally
scopes the complete `native/linux/bridge-rs/src/**/*.rs` inventory, including separately named
`cfg(test)` source modules, and normalizes hosted absolute paths to package-relative paths.
Conventional `tests/` integration source and dependencies are outside that production scope.
A missing or zero-executable source map is accepted only for a conservatively validated module/re-export-only file
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
`coverage.json` (LLVM detail), `run.log`, `commands.log` and `metadata.json` (host, architecture,
elapsed time and SHA-256 of every crate `src` file plus `Cargo.toml`/`Cargo.lock`). Metadata explicitly
labels branches and statements unmeasured. Source hashes bind the report to source bytes, not
an unrelated commit's report; inspect the CI head and compiler receipt as well.
Collect the whole printed directory for review. The logs include test counts and test runtime;
metadata time includes build, tests and all report formats. Compiler output is retained, not
replaced with an invented test count. Doc tests run normally but are not separately instrumented.
The output parent also contains a stable `coverage.json` accounting entry, published only after
report validation; raw reports/logs remain under the unique run directory. CI uploads these files,
not instrumented build products. `setup.log` records pinned-tool setup runtime; `metadata.json`
records total build/test/report runtime plus `commandSeconds` for each corresponding `commands`
entry (test/build and each report rendering separately). A second uninstrumented test build remains in the existing
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

## Native Ubuntu reference

Run [43183336941](https://github.com/nredd/pi-harness/actions/runs/43183336941), source
`793ad317354e12f696204cbdcbe5b11b4dee4433`, artifact `13927707571`
(`coverage-ubuntu-24.04-computer-use`), Ubuntu x86_64, Rust `1.97.1`, LLVM `22.1.6`,
cargo-llvm-cov `0.9.1`, two jobs. Setup: toolchain **7.958s**, collector install **40.316s**.
Instrumented build **24.87s**; full build/test/report **25.198s**. Combined setup/collection
**73.472s**, excluding ordinary package checks. Tests: **33 passed, 1 ignored**, no failures;
the ignored AT-SPI case requires a live session. This producer succeeded despite the initial
package gate's separately fixed drop-control anchor failure; it is producer evidence, not a
claim that the entire initial CI run passed.

The source-scoped counters below are uncovered/total, not percentages or raw LLVM `TOTAL`.
Raw totals also include dependencies and conventional integration-test source. Accounting excludes
those by structural ownership, never by default filename filters.

| Linux source | Lines | Functions | Regions |
| --- | --- | --- | --- |
| `src/atspi.rs` | 283/558 | 33/62 | 503/838 |
| `src/error.rs` | 12/18 | 4/5 | 20/24 |
| `src/lib.rs` | 0/0 | 0/0 | 0/0 |
| `src/main.rs` | 543/970 | 60/100 | 1014/1634 |
| `src/protocol.rs` | 0/18 | 0/2 | 0/10 |
| `src/state.rs` | 42/243 | 11/35 | 63/433 |
| `src/wayland.rs` | 39/43 | 5/6 | 58/64 |
| `src/x11.rs` | 523/759 | 57/85 | 967/1312 |
| **Source total** | **1442/2609** | **170/295** | **2625/4315** |

`lib.rs` has no LLVM map and passes conservative module/re-export-only validation. Its 0/0 is
non-executable classification, not covered executable code. Per-file output preserves this distinction
through its zero denominator. Both branch and statement metrics remain UNMEASURED. The stored
report-only references are L/F = 1442/170; region units are preserved independently in per-file and
aggregate accounting output, not coerced into the policy's LCOV branch budget.

Exact-HEAD producer verification: run [43214341839](https://github.com/nredd/pi-harness/actions/runs/43214341839),
head `3d97e8962b9ebb32a2b084b3a421875571ed90cf`, Ubuntu artifact `13943427896`, archive SHA-256
`a002612e80a4a94191723e6ff9ee0cc1e2a4c624677c93d7d3d3b08d6774dfcb`. Accounting JSON and raw JSON
both hash to `41b52bde5cffc0b8da851e4d9e057361ab0c36e37f8fbb0731a4d9bccd6a3034`; raw LCOV hashes
to `89ca2eb9004d47248dfb734e91179599a983fe2efd80625d5e9176826d1c6790`. Raw JSON and LCOV each
contain all seven executable mapped source files; `lib.rs` remains the validated 0/0 declaration.
Accounting reports the same 1442/170/2625 uncovered source units as the earlier baseline; removing
the accounting JSON fails closed. Build/test/report runtime was 33.328s. This receipt belongs to
that exact prior HEAD, not any subsequent commit. The shard passed; the full run failed separately.

Native artifacts preserve raw per-file lines/functions/regions, setup/run/command logs and elapsed metadata. No Windows-native runtime,
actual AT-SPI/X11/Wayland desktop behavior, focus, physical input or display acceptance is claimed.
Narrow documented live-adapter limitations remain; ordinary platform policy/error paths are not
blanket exemptions. #696 retains deterministic runtime seam closure and the Windows producer.
