# CI

WSL bootstrap explicitly sets `core.autocrlf=false` and `core.eol=lf`, then rebuilds the
**disposable host checkout's** index before resetting to HEAD. Disabling autocrlf or resetting
alone can retain clean CRLF stat entries. The real-Git regression verifies exact tracked text
and unchanged binary bytes; no source assertion or generated-runtime comparison is weakened.

CI is the gate. Local runs are for development. Hosted runners only, no stored credentials or secrets.
The publish job alone requests a short-lived npm OIDC identity.

The `stack` job's `Report coverage exclusions` summary writes only `GITHUB_STEP_SUMMARY` text.
The workflow contract executes that step's actual body with the test runner's `/bin/bash` in
an isolated directory, checks production output-failure propagation, and checks scoped exclusions
separately from shell selection. `stack` has no WSL guest any more, so this is an ordinary step.
Default standalone D/E still skips seven auth cases (#14); candidate compiled-core auth adapter
results require their own outcome and JUnit evidence, not the summary notice. Friendly-prose
changes must preserve those disclosures and the remaining explicit `NOT RUN` scopes.
All guest dispatch remains through the adapter, which labels a failing `pwsh`, `wslpath`, guest
command, or generated guest step while preserving its original exit status and stderr.

`.github/workflows/ci.yml`, every PR and `main`:

| Job | Normal PR | `main` push | Docs-only PR or push | Proves |
| --- | --- | --- | --- | --- |
| `owned (ubuntu-24.04, macos-14, wsl2)` | `make install-owned`, `make check-ts check-scripts check-integration`; `make install-benchmark` and `make check-benchmark` on macOS only. The WSL guest runs `make check-ts check-probes check-import-audit`, and on a PR only with WSL inputs. `cargo-nextest` is installed so dev-tools' real cargo suite runs instead of skipping | Same | Native cells report the bypass; WSL runs on `main`, reports NOT RUN on a PR | Biome, tsc and each package's Vitest suite and declared `test:bun` suite (router, preset, resource-sampler, todo and inprocess run FULL Vitest suites on both engines with the shared homedir guard; subagents retains native scenarios plus a guarded real-loader gate until #174, with its full Node suite guarded; the other packages retain native Bun subsets; a notice names every package without `test:bun`, as NOT RUN), `scripts/` and `integration/` unit gates. `check-benchmark`'s `native_runtime` test needs Seatbelt, so Linux/WSL reports it NOT RUN. See the computer-use note below. |
| `contracts (ubuntu-24.04, macos-14, wsl2)` | `make install-owned`, `make check-package-contracts` (includes the packed preset audit + install), `make check-plan-mode-package-contract`, `make check-subagents-package-contract`, `make check-todo-package-contract`, `make check-computer-use-package-contract`. WSL runs these on a PR only with WSL inputs | Same | Native cells report the bypass; WSL runs on `main`, reports NOT RUN on a PR | Packed tarballs alone on exact stock Pi 1.3.0 (dev-tools with its exact `@nredd/pi-resource-sampler` from the registry, integrity checked against `npm view`, real parent-child discovery by that installed sampler's full scan, and a bounded `resource_snapshot`), the packed preset audited and installed alone, and the packed `@nredd/pi-subagents` with `croner`/`nanoid` from the registry plus one faux `Agent` call (the same gate the release `verify` runs, so a PR proves it before a tag does). The packed `@nredd/pi-todo` with `@juicesharp/rpiv-config`/`rpiv-i18n` from the registry plus one faux `todo` create. The packed `@nredd/pi-computer-use` through the platform-aware tool set (13 tools on macOS, 11 on Linux) plus Mach-O arch/mode checks of both prebuilt helpers; its `postinstall` and every desktop tool are NOT RUN. JSON reports uploaded as artifacts |
| `stack (ubuntu-24.04, macos-14, wsl2; personal, local)` | `stack (ubuntu-24.04, personal)`, `stack (ubuntu-24.04, local)` and `stack (macos-14, local)` run Node release-bundle D/E and build the core Gitlink with Bun for standalone D/E of their own stack. A PR with no stack inputs skips the personal steps. The other three cells report NOT RUN | `stack (ubuntu-24.04, personal)` only; the other two running cells log the selective smoke and the three bypass cells report NOT RUN | Every cell reports a bypass or NOT RUN | Node release bundle plus source-built linux-x64/darwin-arm64 standalone, independent stack installations, startup/transport/lifetime/output/tool surfaces and tmux resize; seven Node-preload auth cases per standalone stack explicitly skip, missing-preload refusal runs. Separate Node/Bun JUnit and failure artifacts, stack identities and binary/archive SHA-256 retained. Computer-use helper explicitly excluded |

There is no `bench` job. `classify`'s step summary and a notice say bench is NOT RUN: no quiet self-hosted runner exists yet (migration plan section 7).

Which cell does what. Every required check name reports, per the ruleset below. A *bypass cell* takes the job name on a cheap `ubuntu-24.04` runner, holds no macOS or Windows slot, runs only the `plan` step and emits a `::notice` plus a step summary saying NOT RUN, why, and that this is not a pass. A green bypass cell is a reported name, not evidence.

| Check | PR | `main` push |
| --- | --- | --- |
| `owned` / `contracts (ubuntu-24.04, macos-14)` | Runs | Runs |
| `owned` / `contracts (wsl2)` | Runs on `windows-2025` only with `wsl_inputs`, otherwise bypass cell | Runs on `windows-2025` |
| `stack (ubuntu-24.04, personal)` | Runs; without `stack_inputs` only setup runs and the personal steps report NOT RUN | Runs, ignoring `stack_inputs` |
| `stack (ubuntu-24.04, local)` | Runs | Selective smoke, not run |
| `stack (macos-14, local)` | Runs | Selective smoke, not run |
| `stack (macos-14, personal)` | Bypass cell | Bypass cell |
| `stack (wsl2, personal)` | Bypass cell | Bypass cell |
| `stack (wsl2, local)` | Bypass cell | Bypass cell |

`scripts/ci_paths.py` publishes both inputs and fails closed: an unreadable comparison, an empty diff or a Gitlink change sets both true. A missing output is treated as true too, because the workflow only tests for `false`.

- `wsl_inputs`: `.github/`, `scripts/wsl2_*`, `scripts/ci*`, `integration/probes/`, the lockfiles and `integration/pyproject.toml`, the guest bootstrap's `scripts/install_gh_linux.sh` and `scripts/install_wsl_owned_tools.sh`, the guest gates' `scripts/import_audit.ts`, `scripts/check-biome-paths.mjs`, `scripts/router_contract.mjs` and `scripts/run-vitest.ts`, `Makefile`, root `package.json` (`packageManager`), `.gitattributes` (the LF checkout), `.gitmodules`, `.node-version`, `.bun-version`, `.python-version`
- `stack_inputs`: `integration/{stacks,harness,scenarios,providers,golden,probes}`, `integration/conftest.py`, `integration/pyproject.toml`, `integration/uv.lock`, `Makefile`, `.github/`, `forks/`, root `package.json` and `package-lock.json`, `.gitmodules`, the same version pins, `scripts/wsl2_*`. `packages/` is not one: `harness.stack` maps those paths into `local`, the personal stack installs published bytes

Evidence given up to cut queue time (issue #297):

- No WSL stack acceptance at all, on any event. Node D/E, standalone D/E and the auth adapter no longer run in WSL
- No macOS `personal` or published-stack run. macOS proves only `local`, on Node and standalone
- WSL `owned` and `contracts` on PRs only with `wsl_inputs`. A `packages/` change that breaks only in WSL fails on the `main` push, after merge
- The WSL guest no longer runs `pytest scripts`, `pytest tests`, or the ruff and ty steps of `check-scripts` / `check-integration`. Ubuntu runs them. `check-probes` and `check-import-audit` stay because `coverage-wsl2` needs their LCOV
- `main` no longer runs standalone `local`: it moved into the `local` cells, which the selective smoke skips on a push. The non-strict ruleset means a merged tree can differ from the PR head that proved it
- WSL distribution packages are no longer upgraded (`update: 'false'`); `additional-packages` still refreshes apt and installs the current packages

On the `owned` job, `@nredd/pi-computer-use`'s macOS-only checks (`test:invariants` INV-8/INV-17, `test:macos-native`, `test:desktop`'s helper wire mapping and gating, `test:macos-live`) print `NOT RUN` lines on Linux and are not passes. Conversely, `test:linux-native` runs headless on the Ubuntu and WSL cells (`NOT RUN` on macOS): the crate's `cargo test --locked`, a source build from the *packed* tarball into a user-cache target dir, the built x64 helper's real `diagnostics` (protocol 4, shared architecture invariants), the cargo-missing hint and compiler cleanup on `SIGTERM`. The aarch64 target (`rustup target add`) is `cargo check --locked` compile-only; ARM64 runtime, desktop/display and live UI are NOT RUN. This is coverage inside the existing `owned` job, not a new required check (`test:linux-native` prints `Linux native checks passed` on Ubuntu, `NOT RUN` on macOS.)

Phase 0 coverage runs inside the existing primary and declared Bun test invocations, never a
second CI test pass. Each Vitest config explicitly includes owned source, uses text + LCOV and
`reportOnFailure`; `subagents` retains Istanbul because V8 reload merging is incorrect. The
existing Node helper gates use c8. An `always()` step after owned tests consumes those independent
reports with `scripts/coverage_accounting.py`, selects `darwin` / `linux` integer uncovered-line/function
floors using `sys.platform`, compares **every OS's enforced floors** with the PR base's `coverage/policy.json`,
and fails closed on missing/invalid input or a missing OS floor. Hosted artifacts, not a local Mac,
establish per-runner floors. `owned (wsl2)` runs inside Ubuntu with `sys.platform == "linux"`
and explicitly enforces the same Linux floors as native Ubuntu. It exports independent LCOV and
summary reports from the Linux filesystem before Windows uploads `coverage-wsl2`; no counters
are combined across runners. Native Windows coverage is not measured. WSL contract
scenarios remain separate acceptance evidence, not owned-source coverage. To regenerate a review-only policy diff from an
artifact, run `uv run --locked --project integration python scripts/coverage_accounting.py --measure
--os linux --reports-root /tmp/cov-linux --summary /tmp/measured-linux.json` (use `darwin` and its
artifact for macOS). The full download/replay and independent-two-run comparison procedure is
[here](coverage.md#refresh-floors-from-hosted-artifacts); this command never edits or commits policy. Branches
are reported only: `Counts`, the accounting budget predicate and the base ratchet enforce only
lines/functions. Darwin sampler branch variation (#164) changes no floor. Final hosted run
`40857829296` establishes zero primary misses for all eight packages on macOS and all except
resource-sampler on Linux. Linux retains 47 lines / 8 functions in native `darwin.ts` paths as
an explicit per-OS floor, not an exclusion. Session-kit now has zero primary misses on both
OSes after the deterministic formatter test removes the incidental comparator hit (#163).
The earlier 110/32 transitional floor is historical only. Another `always()` step retains LCOV and the per-package/per-file JSON summary
on either outcome. All current Bun signals explicitly use `enforcement: "report-only"` with
mandatory reasons linked to #160. They retain fail-closed LCOV parsing, expected-file checks,
per-OS references, inventory ratcheting, and text+LCOV reporter checks. Counts and signed deltas
from references are logged and included under JSON `signals`; budget excess alone cannot fail
these advisory signals. Primary budgets stay enforced and define the 100% goal. Never merge
Bun counters into primary coverage.

The owner's roughly 1-7% small-subset description is not a measured source-coverage percentage:
hosted run `40455349710` has plan-mode 8/539 Bun/primary tests (1.5%), subagents 22/3078 (0.7%)
and todo 2/387 (0.5%); preset and in-process run their full test sets. The precise limitation is
incomplete verified source scope. A strict Bun budget blocked main #153's primary-tested additions
(subagents Bun 7728/512 -> 7763/515, primary unchanged at 500/68 on both OSes).

A package flips to `enforced` only after its full suite runs under Bun on both OSes AND Bun's
inventory covers every owned executable source file, including never-imported files, as specified
by #160. Accounting rejects enforced partial Bun inventories. Any later enforced-to-report-only
flip requires a new reasoned `enforcement_changes` entry relative to base; standing reasons or
historical approvals cannot silently waive enforcement. Initial policy introduction is allowed.
Enforced-to-enforced floors ratchet per OS; advisory references do not become hidden budgets.
`computer-use` is not measured, tracked. `dev-tools` uses #195's primary Istanbul decision with
all 22 executable modules and zero uncovered lines/functions on both hosted OSes after #155.
Its independent native Bun scenarios remain advisory. Python tooling/harness code, remaining boundary probes/providers,
benchmark source and producer configurations are also explicitly inventoried as measurement-pending.
The repository-wide TS/Python/JavaScript audit and the base-tree/current-tree inventory ratchet
prevent silent source omission; reasoned reclassifications are required for membership losses.
Verification-only scripts have exact per-file `verification_helpers` reasons; shipped runtime
scripts remain owned production source, never blanket helper exclusions. The policy's eventual
global-zero flip refuses pending packages.
No job or required-check name changes. Definition, exclusions, receipts and ratcheting:
[here](coverage.md).

The resource sampler's package gate runs real host sampling and bounded helper cleanup in each
`owned` OS cell. `check-package-contracts` also builds/audits/installs its exact ESM tarball and
runs an isolated Node consumer in each `contracts` OS cell. This library has no Pi entrypoint;
Darwin process CPU is native interval CPU on Node >=26.1 and Bun, authenticated with libproc
start identity rather than `ps` whole-second precision. Older Node remains explicitly unavailable.
No consumer migration, publication, extra CI job or runner is added.

## Standalone startup failure evidence

The Linux personal cell runs one extra **strict** text startup before D/E: the same explicit
personal stack, faux provider, `STACK-OK` output, zero exit and empty stderr as
`test_extensions_load_without_warnings[text]`. No retry can turn a failure green. On failure only,
`standalone-startup-linux-x64` retains the exact executable and `SHA256SUMS` for seven days.
The normal standalone suites still run and retain their original assertions.

`harness.standalone_diagnostics` stages an explicit allowlist and scans *every input*, binary
included, through the shared `harness.credentials.require_safe_diagnostic` policy before atomically
publishing the upload directory. This preserves #178's npm (at least 36 alphanumerics), short GitHub,
sk/pk, Slack and general private-key signatures alongside main's nonempty JSON/Bearer and release
URL/proxy policy. There is one shared scanner, not a collector-local duplicate. Signatures are
conservative heuristics, not a guarantee against every secret format. A scan or capture failure
leaves no partial upload and cannot mask the original failing exit status.
The upload also requires the probe's `artifact_ready=true` output, emitted only after a new
scanned publication; stale directories and early failures cannot authorize an upload.
It never copies installed homes, `auth.json`, `.storage`, sessions, environment dumps or token stores.
All subprocesses use a new harness fixture HOME, empty synthetic auth and the existing command shims.
This is diagnostic hygiene, not isolation from malicious same-UID package code.

Artifact files:

- `pi`, `SHA256SUMS`, `build.json`: exact executable, per-file SHA-256, schema-validated
  Gitlink/harness SHAs, tool versions, build/startup commands and separate primary/replay verdicts.
- `compile-command.json`, `module-graph.json`, `build.log`: the actual compile argv, Bun's
  module graph and the frozen-data build log. A transparent build-only Bun wrapper adds
  `--metafile`; it changes neither core sources nor production pins. Missing optional metadata
  is explicit; a graph cannot establish the undefined symbol's cause by itself.
- `packages/pi-memory/{index.ts,package.json,npm-lock.json}` (the lock's memory entry only),
  `core/*.js`, `core/*-package.json`,
  `core/package-lock.json`, `harness-package-lock.json`, `stack.json`: named public package/build
  inputs only, with original bytes. No recursive package or home upload.
- `startup.{stdout,stderr}` and `jiti/primary/*`: byte-exact original failed startup streams (including
  CRLF and invalid UTF-8) and *only*
  Jiti 2.7 transform filenames keyed to this fixture's exact `pi-memory/index.ts` path (MD5 and
  FIPS SHA-256 naming variants). Cache absence is recorded, not replaced with another run's code.
- `replay.{stdout,stderr}`, `replay-wrapper.ts`, `jiti/replay/*`: supplemental failure-only replay.
  In the disposable fixture, memory's resource declaration/filter selects a wrapper at the same
  package-order slot. It imports the untouched original entry, prints `error.stack` before Pi
  reduces it to a message, then **rethrows**. Original package manifest/source/cache bytes are
  captured *before* this instrumentation; the executable is never rebuilt or patched. A replay
  passing or failing differently does not replace the primary failure or prove a root cause.
  Replay streams are also raw bytes. Primary-stream decoding is separate, only for strict startup matching,
  never for artifact contents. Timeouts retain untouched partial streams (absent data becomes empty
  bytes), use synthetic exit status 124 and record `startup_timed_out`/`replay_timed_out` in `build.json`;
  no annotation is appended to stderr. A normal child exit 124 remains distinguishable from a timeout.

To diagnose an already-built binary without running the whole suite:

```sh
cd integration
uv run --locked python -m harness.standalone_diagnostics startup \
  --binary /absolute/path/to/linux-x64/pi --core ../forks/pi \
  --build-evidence /absolute/path/to/pi-build-evidence \
  --output /absolute/path/to/new-failure-evidence
```

For PR #178's exact graph, cherry-pick the diagnostic harness commit onto that branch and run its
normal CI. The workflow observes that branch's existing frozen-core build; do not copy a binary
from this diagnostic PR or change package/core/Bun pins. Do not reuse an installed live HOME.
Local successful startup creates no artifact. A deliberate synthetic throwing memory factory can
verify the raw-stack/capture path, but is not a reproduction of the unexplained CI `Type3` failure.

## Startup exit failure evidence

The existing per-scenario artifacts now retain `*.pane.json` captured **before** tmux teardown,
`*.exit` wrapper status files when present, and raw startup/RPC `*.stderr`. The pane report keeps
the native PID/dead/status/signal response (empty fields can mean unsupported tmux formats), the
wrapper status path and its contents or absence; a vanished server is recorded as an error rather
than replacing the original failure. Only these named artifact patterns are added to the existing
allowlist, never arbitrary JSON, environment dumps or a recursive sandbox HOME. Every candidate's
complete raw bytes, including existing sessions/screens, are scanned **before publication**.
`harness.credentials.require_safe_diagnostic` is the shared publication policy: it reuses
`release.redact_diagnostic` for URL/known proxy credentials and centralizes the signature rules
extracted from the #191 collector. Both scenario publication and the standalone collector consume
this same helper, with no collector-local credential regex or dependency from the shared helper
back onto a collector. Long token/key signatures remain checked. Explicit canonical JSON string
fields `access_token`, `refresh_token` and `api_key` are refused for **any nonempty string value**;
case-insensitive `Bearer` followed by any nonempty whitespace-delimited value is refused regardless
of length. Empty/null credential slots and metadata keys such as `api_key_available`,
`access_token_count`, `auth_type: "Bearer"` and `token_count` are not auth dumps by themselves.
The Bearer rule deliberately may reject prose describing a token. Signatures are heuristics, not
proof against arbitrary secrets, unknown/escaped credential keys or encoded values.

Candidates are staged outside the uploaded artifacts root, scanned and written from the same byte
snapshot, then renamed into place only when the complete set is safe. Any unsafe/unreadable candidate
or staging error refuses the whole set, removes stale publication and leaves the primary verdict
unchanged; raw bytes are never redacted into a misleading "exact" capture. Every ancestor from the
sandbox root itself through the candidate's parent must be an actual directory, including internal
parent links that happen to resolve inside the sandbox. Candidate reads reuse the `harness.files`
regular-file pattern: reject known nonregular entries before opening, then use `O_NOFOLLOW`,
`O_NONBLOCK`, `O_NOCTTY` and descriptor `fstat` before reading. Final symlink/FIFO replacements cannot
turn cleanup into a blocking FIFO read. Ancestry checks are observations, not a descriptor-anchored
sandbox against concurrent malicious same-UID parent replacement. No broader filesystem-security
claim is made. Pane reports use a strict `PaneExitEvidence` Pydantic model. Missing tmux, invalid UTF-8
markers and capture/write failures cannot prevent server teardown. RPC evidence open/write/flush
failures disable only the disk sink: bounded pipe drainage and in-memory diagnostics continue.
This supplements, not duplicates, the separate standalone build/startup collector from #191.

Observed on 2026-10-28, both in `Standalone D and E (local)`:

- PR #155, run `40666549747`, job `122742471639`: `ordinary-session_start-tui` fails with
  `TUI never reported its exit status`. Its saved screen contains `STARTUP-OK` and the resume hint.
  Original `pi.stderr` reports `Bun v1.3.14 (0d9b296a) macOS Silicon`, macOS `14.8.9`,
  `Elapsed: 8573ms`, feature `exited`, and `Segmentation fault at address 0xC`.
  The decoded trace [here](https://bun.report/1.3.14/M_10d9b296mggQugggC______mk04Yuw4uhBu7l7H_2lkjlDurh5kD27p5tC+xt2yC+1+3H_2lkjlDurh5kDunr21Cusw11CA2AY)
  resolves through `jsc.VirtualMachine.globalExit`, `Bun__Process__exit` and
  `Bun::Process_functionReallyExit` / `Process_functionExit`.
- PR #178, run `40667021371`, job `122744482131`: the failure is instead
  `ordinary-session_start-rpc`, `subprocess.TimeoutExpired` after 60 seconds. Its TUI case passes.
  The traceback's truncated `stderr_seq` contains the Bun `1.3.14` crash banner; the original full
  timeout stderr was not archived. The `-9` return code is observed after Python's timeout kill,
  not a successful runtime shutdown.

Both include a curl-shim `Bad file descriptor` error. Bun's macOS crash reporter invokes curl
([here](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/crash_handler/crash_handler.zig));
that downstream error is not evidence that an extension's curl caused the crash. The historical
artifacts lack pre-cleanup pane state and `*.exit`; they cannot distinguish a live crashed process
from a dead wrapper or missing status file. RPC does not use that wrapper at all.

A local rebuild of Gitlink `2bfb8e7c61d35167b09f8ce70693df39660fc197` with Bun `1.3.14` and frozen
release model data passed 29 original TUI and 29 RPC startup calls, including two concurrent drivers.
The initial two-case command was `PI_BIN=<rebuilt-pi> uv run --locked pytest
'scenarios/test_startup.py::test_fatal_startup_modes[ordinary-session_start-tui]'
'scenarios/test_startup.py::test_fatal_startup_modes[ordinary-session_start-rpc]'
--stack stacks/local.json --runtime bun-standalone -q`: 2 passed. A diagnostic driver then invoked
that unchanged scenario function on copied explicit fixtures: 12 serial pairs, then two concurrent
drivers of 8 pairs each (qmd failure shim for the concurrent run), all passed. Recorded local logs:
`/tmp/fix-tui-repro.log`, `/tmp/fix-tui-repeat.log`, `/tmp/fix-tui-stress-a.log` and
`/tmp/fix-tui-stress-b.log`; these workstation logs are not durable CI artifacts.
This is not a native-crash reproduction or a fix. Synthetic abort and timeout tests prove the
original nonzero/timeout failure and raw evidence survive cleanup; no assertions, deadlines, Bun
pins or runtime behavior are relaxed. The exact native trigger and a failing-CI pane-state capture
remain unresolved. No capacity cancellation is classified as this failure.

Final privacy/cleanup proofs additionally reject internal parent/root links and a root `pi.stderr`
FIFO without ever opening it for reading. Stale regular-file prechecks with a FIFO or final symlink
replacement are refused through the descriptor checks; removing `O_NONBLOCK` fails a pre-open test
assertion, so the mutant cannot hang the test. Short synthetic fields/Bearer values are injected
across all seven artifact categories while the primary exception remains unchanged and no artifact
set is published. Public metadata negative controls still pass. Removing ancestor checks, restoring
plain `Path.read_bytes`, reverting the short-credential rule, or removing `O_NONBLOCK` each fails a
focused mutant (workstation logs `/tmp/tui-finalprivacy-mutant-{ancestry,regular,short,nonblock}.log`).

Blocker regression receipts:

- Unsafe-byte injections cover markers, pane reports, raw stderr, screens, scripts, event logs and
  session history for token signatures, URL credentials and known proxy passwords. No partial/stale
  artifact tree is published; injected staging write failure preserves the primary assertion.
- Missing-executable/server/I/O pane queries still attempt teardown. Invalid UTF-8 marker bytes
  remain unchanged, produce an explicit model error field and retain the original decode failure.
  Real fixture-generator and direct-startup-owner tests inject missing tmux, screen decode and
  screenshot write errors: every owned pane is killed and the primary failure is retained.
  An unavailable final screenshot cannot replace `wait_dead`'s exit-status assertion.
- RPC evidence open/write/flush failures still drain 262144 stderr bytes plus a tail diagnostic;
  the real child exits 17 without pipe blockage and bounded in-memory diagnostics retain the tail.
- The startup proof prints the required startup message and observes exit 17 specifically. Its
  exit-0 control succeeds. Mutating the observed exit 17 to 0 makes that regression fail with
  `DID NOT RAISE AssertionError`, rather than accidentally testing the missing-message assertion.
- Mutation checks disable scanning, restore the prior pane capture, restore the prior RPC writer,
  and change the nonzero result to zero. All four are killed by the focused regressions. Local
  logs are `/tmp/tui-mutant-{scan,pane,writer,zero}.log`, not durable CI artifacts. Restoring the
  old fixture teardown or final timeout screenshot separately also fails the caller regressions
  (`/tmp/tui-mutant-teardown.log`, `/tmp/tui-mutant-wait-capture.log`).

## Capacity controls

`classify changed paths` compares the pull request base and head, or the pre-push and pushed `main` revisions, with real Git. It never path-filters a required job: all twelve matrix jobs start and report a terminal status. A docs-only change skips the native Linux/macOS expensive steps; a WSL cell on a PR is a bypass cell then anyway, and a real WSL cell on `main` still runs. Every skipped job writes a notice plus a step summary. Each job's `plan` step emits `run=true` or `run=false`, logs why when bypassing, and gates every checkout-dependent step on `steps.plan.outputs.run`. `stack` also emits `scenarios`, which is false only for a personal cell on a PR with no stack inputs: setup still runs there, the `Replay`, Node D/E, build, startup, standalone and auth steps do not. `always()` cleanup and artifact steps, plus failure and cancellation conditions, remain in those step predicates. Windows-only steps gate on `runner.os == 'Windows'`, not `matrix.os`, because a WSL bypass cell keeps its matrix values on Ubuntu; `plan` tells the two apart with `RUNNER_OS`.

The allowed docs-only paths are Markdown under `docs/`, root Markdown, `PLAN.md`, and a package-root `README.md` or `CHANGELOG.md`. The classifier is deliberately narrower than "all Markdown": workflow files, manifests, lockfiles, Gitlinks, `integration/**`, `scripts/**`, and `releases/*.json` are code because they do not match an allowed path. It also treats root `README.md` and `packages/preset/README.md` as code because repository tests read their text. A mixed change is code.

The 2026-10-20 capacity measurement found median final-head PR latency of 11m45s, p95 queue waits of 22m37s on macOS and 19m56s on Ubuntu, and four macOS jobs in each full run against five hosted macOS slots. A docs-only `PLAN.md` PR alone consumed 100.25 runner-minutes across 18 stack executions. Bypassing that work reduces real contention without leaving a protected check pending.

`main` still validates the merged result: all `owned` and `contracts` OS cells including real WSL, and `stack (ubuntu-24.04, personal)`, which `harness.promotion` needs for its `stack-ubuntu-24.04-personal` artifact. `stack (ubuntu-24.04, local)` and `stack (macos-14, local)` report the selective smoke. The same measurement found six explicit update-branch CI runs plus one Forks run used 180.07 assigned runner-minutes; full main-push workflows used 599.13 assigned runner-minutes, including 334.02 macOS minutes. Those are upper bounds, not promised savings.

PR runs cancel each other per ref. `main` runs do not: `cancel-in-progress` is PR-only and the concurrency group is per SHA on push, because GitHub drops an older pending run in a shared group even without cancellation. A push cannot kill the run proving the previous merge.

The required checks live in ruleset `main required checks` (id `25524267`, not classic branch protection), with `strict_required_status_checks_policy: false`. It is not strict: advancing `main` does not invalidate a PR's previous green result, so the merged tree can differ from the tree CI saw. The `main` push run is what validates it.

WSL2 is `matrix.os: wsl2` in the same `owned` and `contracts` jobs in `.github/workflows/ci.yml`; `stack` keeps the name only for its bypass cells. `matrix.runner: windows-2025` selects the host; `matrix.guest: wsl2` selects the explicit PowerShell -> WSL shell boundary, with Ubuntu-24.04 verified as version 2 and a non-`drvfs` guest checkout. Never a fictitious GitHub runner label or native Windows execution. There is no separate WSL workflow or duplicated WSL test job.

WSL runs the owned gates that produce LCOV and all packed contracts through the ordinary shared steps. Mac-only Seatbelt, desktop/TCC, live credentials and ARM64 runtime remain NOT RUN. Linux helper checks and ARM64 compile-only checks now run inside the owned WSL guest, not on its Windows host.

Shared setup lives in `.github/actions/setup-ci-tools`, with WSL-specific host setup in `setup-ci-wsl` and tool bootstrap in `scripts/wsl2_setup.sh`. Node, npm, Bun and Python read `.node-version`, `packageManager`, `.bun-version` and `.python-version`; uv stays at the existing CI pin. The pinned, checksum-verified `scripts/install_gh_linux.sh` supplies attestation-capable gh. Only owned cells need Rust/nextest. The contract graph is `Makefile` -> `stock_package_contract.py` / `npm_release.run_stock_contract` -> `package_contracts.run_gate`: npm pack/install use `--ignore-scripts`, computer-use audits its Rust source and Mach-O assets without running `postinstall`, and the resource-sampler build is `tsc`. No contract builds Rust; helper compilation remains owned coverage, not a skipped contract. Native setup-node's npm cache remains native-only; WSL uses its guest HOME tool cache, never Windows Node/Bun/cache paths. Frozen model-data tarballs, strict locks and release verification remain in the shared gate steps. Bun follows the repository's pinned `1.4.4` from merged #197 through `.bun-version`; #162 must preserve its future coverage producer/upload steps through this guest boundary when integrated.

A WSL-only pre-plan step selects `$ProgramFiles/Git/bin/bash.exe`, asserts the first ordered `Get-Command bash.exe -All` application resolves there, prepends that directory through `GITHUB_PATH`, and records the executable and `--version` in hosted logs/summary. The custom shell starts `bash scripts/wsl2_host.sh`, rechecks the resolved Windows source against that receipt (also accepting Git's own `usr/bin` binary), and delegates to `scripts/wsl2_shell.ps1`. Native defaults explicitly retain the prior implicit `bash -e {0}` behavior, without adding `pipefail`. GitHub must see a Bash shell so it does not inject PowerShell pre/postamble into the guest script; the initial direct `pwsh` shell failed with `=: command not found` before the first shared command. The Git-Bash launcher sets `MSYS2_ENV_CONV_EXCL=PI_BIN` before starting native PowerShell: the 45689e3 stack jobs otherwise rewrote `/root/.../pi` into `C:/Program Files/Git/root/.../pi`. Ordinary Windows PATH conversion remains enabled. The PowerShell adapter forwards an explicit `WSLENV` allowlist. Every host-to-guest call uses `wsl --exec` with a translated script-file argument, never a nested `-c` command string. This avoids the initial hosted attempt's lost variable expansion (`/scripts/wsl2_setup.sh` instead of the checkout path). GitHub control-file paths translate to mounted paths, while `RUNNER_TEMP`, builds and execution stay in the Linux filesystem. `GITHUB_ENV` carries Linux `PI_BIN` values unchanged between steps. Only the existing verification/fetch steps receive `GH_TOKEN`; guest bootstrap and scenarios do not. `make install-owned` scrubs the token from npm/uv children. The separate stack install step retains its native commands and receives no token in the first place; only the adjacent verify/fetch steps declare one. The token is never dumped or written by these scripts. The existing same-repo workflow trust assumption applies; this is not a sandbox against arbitrary PR code.

Run `40824209455` exposed a root-user error, not DrvFs: owned tests ran from `/root/pi-harness-ci`, so uid 0 bypassed chmod-based EACCES checks. Setup now creates `pi-ci`; bootstrap, ordinary gates and capture explicitly select that unprivileged user, keeping the checkout under its Linux home. Setup and execution reject uid 0 before copying or running gates; identities record uid and filesystem. Permission tests remain unchanged. The first unprivileged bootstrap attempt (`40852212874`) failed before creating the user because WSL's direct-exec PATH omitted `/usr/sbin`; user creation now invokes `/usr/sbin/useradd` explicitly. Run `40854016032` then reached passing WSL Node scenarios but exposed DrvFs export metadata failures (`cp: preserving times ... Operation not permitted`). Guest-to-host artifact and cleanup copies now use recursive no-dereference copying without archive-mode metadata preservation; guest builds/tests remain on Linux and retain their permission semantics. The same run's owned setup stopped inside install-action's system-prerequisite installation group (missing `jq`); `setup-wsl` now installs `jq` with the root-owned apt prerequisites before dropping privileges. Rust/nextest installation remains unprivileged, without granting sudo access. The native owned failures were a stale contract requiring `always()` on the scanned startup failure-only upload. That upload retains its `!cancelled()`, failure and `artifact_ready` predicates; ordinary reports still require `always()`.

The guest boundary forwards `GITHUB_EVENT_PATH/p` alongside `GITHUB_EVENT_NAME`, so computer-use's
commit gate reads the translated original PR/push payload rather than falling back to local history.
A host-allowlist/real-guest-adapter regression runs the actual commit gate over a disposable PR range;
removing the payload entry fails closed with the same missing-event error as hosted WSL.

A real WSL cell retains no docs-only or main-push bypass. Unavailable WSL, wrong distribution version/filesystem, bootstrap or gate failure fails the cell. Before ordinary artifact uploads, `capture-ci-wsl` exports only explicit synthetic artifact directories and contract JSON reports to the host. `scripts/wsl2_capture.sh` still handles the former stack artifact directories; no CI job feeds them now. Native standalone artifacts are `standalone-<platform>-<stack>`, one per running stack cell, each holding only its own stack's reports. Native Node reports have the preceding `stack-*` upload. The startup diagnostic upload stays `standalone-startup-linux-x64`, personal cell only. The promotion consumer still reads `stack-ubuntu-24.04-personal` (`harness.promotion.PERSONAL_STACK_ARTIFACT`), unchanged; it does not consume standalone uploads. Final cleanup preserves the first guest-step failure status and bounded diagnostics. Early host diagnostics survive setup failures. No arbitrary worktree files, command logs, environment or HOME are uploaded.

Owned guest tools reuse the exact native `taiki-e/install-action` SHA from `setup-ci-tools/action.yml`: `install_wsl_owned_tools.sh` runs its documented `main.sh`/`INPUT_*` interface with Linux/X64 metadata, checksum verification and `fallback: none`. Its manifest pins nextest to the same action-selected version as Ubuntu; no unversioned source compilation remains. Guest Rust follows the action's documented floating stable policy with rustfmt/clippy components; native Rust comes from the runner image, so each logs actual `rustc`, `cargo`, and `cargo nextest` identities rather than claiming identical compiler versions. References: [here](https://github.com/taiki-e/install-action/tree/8cca0918f8471c33515202b73f56ab27f2bed283#security-on-installation-from-github-releases).

Run `40747213391` at `0d2bfb0` rejected every WSL cell in the pre-plan assertion: PowerShell returns an application collection, so comparing all `.Source` values to one expected path also compared later legacy candidates. A local real PowerShell 7.6.9 duplicate-application repro confirms that false rejection. Selection now takes only the first ordered application, logs actual/expected paths, and still rejects a legacy first candidate. This is not hosted acceptance; the previous run did not reach guest setup.

Run `40742019252` at `45689e3` reached release installation in both WSL stack jobs, but their `PI_BIN` conversion caused failures before D/E could pass. Contracts failed earlier with HTTP403 in `setup-wsl`'s `wsl --update`. The action runs that only for `ImageOS == win22`, so `windows-2025` takes it out of the path entirely. `update` is independent: it only controls the apt `upgrade`, and `update: 'false'` drops that cost, while `additional-packages` still runs `apt-get update` first.

Reproduce guest execution on a Windows machine with WSL2 Ubuntu-24.04 using the same setup action and `scripts/wsl2_shell.ps1 <step-script>`; run the ordinary Make targets and pytest entrypoints above. A local macOS shell test proves adapter behavior, not WSL execution. Acceptance of a WSL change requires the exact-HEAD hosted `owned (wsl2)` and `contracts (wsl2)` cells and their normal artifacts, plus the native cells; local tests are not a hosted receipt. CI triggers remain every pull request and main push, without workflow_call/dispatch or path filters; permissions stay contents-read and the concurrency group is per ref on PRs and per SHA on push.
REA is retired, not pending WSL acceptance.

`.github/workflows/installer.yml`, PRs and `main` pushes that change the installer or the harness modules it reuses, plus manual dispatch with a `stack_sha`:

| Job | Runs | Proves |
| --- | --- | --- |
| `installer (ubuntu-24.04, xcode-27)` | `make -C integration installer` with `INSTALLER_SPEC` set to this exact commit (`git+https://...@<sha>#subdirectory=integration`) and `STACK_SHA` the published promotion. The installer reads no token. On `main` pushes/dispatches and owner-reviewed same-repo pull requests (`head.repo.full_name == github.repository`), `GH_TOKEN` is set for the fallback when hosted runner IPs hit GitHub's anonymous 60 requests/hour limit. Job permissions are only `contents: read` and `attestations: read` (needed to fetch attestations); no write permissions are granted. Only the separate `Authenticate gh attestation fallback` step sees `GH_TOKEN`: it pipes the token to `gh auth login --with-token --insecure-storage` with `GH_TOKEN` unset in that child and a temporary `GH_CONFIG_DIR`. `--insecure-storage` deliberately confines the ephemeral login to that private plaintext config rather than an OS keychain, so removing the directory removes the login. `make` and pytest receive only the nonsecret directory path (`INSTALLER_GH_CONFIG_DIR`), not a token. Acceptance wraps `gh` alone to set `GH_CONFIG_DIR` to that path; `uvx`, Git, package builds and other installer children receive neither variable nor token. An always-running cleanup removes the login directory. Fork PRs and non-main dispatches stay anonymous and fail if the limit refuses them (`test_installer_workflow_token_policy` pins and evaluates the expression; `test_installer_workflow_token_permissions_are_read_only` pins permissions and checkout credential stripping). Triggers cover the installer's `harness` import closure, `conftest.py`, `.node-version`, `Makefile`, `pyproject.toml` and `uv.lock` (checked by `test_installer_workflow_covers_its_inputs`). | The documented one-shot `uvx` command in throwaway HOMEs: missing prerequisites, an unpromoted SHA, real `gh` rejecting tampered bytes and a foreign signer/ref, a fresh install equal to the snapshot (order, filters, disabled computer-use, owned npm integrity), a no-op rerun, consent and preservation with an existing setup, and a SIGKILL during staging then a clean rerun. See [install](install.md). |

TRUST assumption: same-repo PR branches are owner-reviewed code. Same-repo `pull_request` workflows are not fork-sandboxed: a branch author can edit the PR's workflow to request write permissions or reference secrets. The read-only block constrains this submitted workflow only; it is not a security boundary against arbitrary same-repo PR code. KNOWN RESIDUAL: same-UID package code inherits the PATH-prepended `gh` shim through `uvx`, the installer, `pi install`, npm/package scripts and Git children that preserve PATH. `make`/pytest also receive `INSTALLER_GH_CONFIG_DIR`; stripping it and the token variables from other child environments does not remove the capability. A child can invoke the shim to authenticate or read its embedded config path and plaintext `hosts.yml`. This is known credential-capability leakage, not merely a theoretical filesystem permission concern. It remains within the same-repo trust assumption: the submitted job token is read-only, but branch authors already control their workflow. No claim of package-script credential isolation is made. The sentinel subprocess test `test_acceptance_token_environment_is_clean_but_gh_capability_remains` demonstrates both clean environments and successful same-UID credential retrieval using the real CLI and a real-format `hosts.yml`.

It is not a required check and has no docs-only bypass; it only starts when its paths change.

`.github/workflows/forks.yml`, when the remaining `forks/pi` Gitlink, `.gitmodules` or the workflow changes, plus manual dispatch:

| Job | Runs |
| --- | --- |
| `core (forks/pi)` | `npm ci`, the release's model data restored from npm `@earendil-works/pi-ai@<version>` (never the live fetch), `npm run build:offline`, the steps of the fork's `check` with Biome check-only (the step fails if the fork's `check` list changes), the env daemon, `./test.sh` |

`integration/inprocess/`, the private `A-stack` workspace, runs in `check-ts` on Vitest and Bun:

- `make install-owned` first runs `make verify-root-overrides` (see [releases](releases.md)); `owned`, `contracts`, `stack` (a dedicated step before `npm ci`, plus the core fetch) and `publish.yml` verify pass the read-only job token as `GH_TOKEN` to those steps only, for non-legacy core tags. Hosted Linux and macOS runners ship a `gh` with `attestation`.
- `owned` initializes only `forks/pi` (core) before `make install-owned`. The extensions load from
  `packages/{subagents,plan-mode,todo}`; no package-local `npm ci`, no package-local host copies
- `support.ts`: `startStack({ cwd?, factories, settings?, sessionManager?, useModelRuntimeStream?, withConfiguredAuth?, mode?, ui? })` creates and
  binds core's real harness. `loadFork(name)` imports the imported package's declared entry from `packages/<dir>`; `loadOwned(name)`
  imports the owned plugin's `src/index.ts`. Direct `createXxx()` factories work too
- Before importing a package workspace, resolve `pi-coding-agent`, `pi-tui`, `pi-ai`, `typebox` from both directories
  and compare real paths. A mismatch or unresolvable entry fails with the package's `node_modules/`
  deletion path. Node uses import conditions on `createRequire().resolve`; Bun uses
  `import.meta.resolve` with an explicit parent. No aliases or copied extension code
- Root workspace dependencies supply `croner` `10.0.1`, `nanoid` `5.1.16`, `pi-tui-kit` `0.65.5`
  from the imported packages' historical lockfiles. Root also anchors `nanoid` `5.1.16`: otherwise npm hoists PostCSS's
  `3.x` and leaves the imported subagents package's `5.x` unreachable inside the stack workspace. The `rpiv-todo`
  source lockfile was retired with its Gitlink; the stack workspace pins `rpiv-config` and optional peer
  `rpiv-i18n` to the imported package's `2.13.9` provenance, with the same integrity as that historical lockfile
- The test launcher isolates `HOME` at process spawn on both engines. `isolateStackHome()` keeps
  that home fixed (Bun caches `os.homedir()`), isolating `PI_CODING_AGENT_DIR` and XDG config
  independently per fixture before loading entries.
  `plan-todos.test.ts` drives the real Plan/todo pair, canonical RPC chooser selections, core
  compaction with scripted summaries, file-backed dispose/reopen and legacy mode entries.
  `/todos` heading counts share the evidenced-batch test; no second process
- `goal-support.ts` shares one injected clock across the real kit, router and subagents factories,
  with credential-free usage snapshots and explicitly configured faux auth. Goal/Plan/todo,
  loop/Plan, child accounting, scheduled/busy/idle notices and quota park/refuse/resume tests
  run on the same host. The child runner loads the real kit itself. All assertion destinations
  and native timer boundaries live in the ledger: [here](verification-rebuild.md)

- `stats-plan.test.ts` checks the explicit `viewer last import` label and cycles through
  Overview, Models and Machines while Plan mode remains enabled; the Machines view retains
  viewer-import and local-scan evidence across terminal resizes.
- `memory-deferred-kit.test.ts` loads real npm memory/context-engine factories with session-kit:
  memory write/read and system-message refresh coexist with hidden monitor registration,
  session-lifetime search promotion and successful controlled monitor execution. qmd is a
  failing fixture shim; no network is allowed. The D `test_extension_coverage.py` canaries
  separately prove installed registry/commands, memory persistence/path rejection, workflow
  list/missing-run behavior, a clean refused-loopback raw web fetch error and computer-use's
  installed-but-not-loaded headless exclusion. No version pins are copied into scenarios.
  The per-extension matrix is [here](verification-rebuild.md#shipped-extension-coverage-audit),
  with each layer's actual assertions and GUI/live limitations. The shared third-party loader
  resets pi-memory's own path/snapshot/qmd caches before a new fixture: Bun caches npm modules
  across test files, so import-time state must not retain a deleted prior private home.

The unit gates must not read the machine: the first CI run found three `integration/tests` that only
passed on the owner's laptop (`pi` on `PATH`, the chezmoi source tree). They are gone or isolated.

Verification engines: Vitest stays the owned TypeScript runner, with Node primary (the shipped
runtime) and Bun the standalone target. Full Vitest runs on both engines for
`subscription-router`, `preset`, `resource-sampler`, `todo` and `integration/inprocess`.
`test:bun` launches `bun --bun vitest run` through `scripts/run-vitest.ts` in a disposable
spawn-time home; `make check-ts` and both existing `owned` OS cells run it. Each invocation
prints engine/OS/package duration and exit status and appends it to the CI step summary.
The shared guard checks `os.homedir() === HOME` at setup, before each test and after each test,
failing with the offending file and an instruction to inject home directories. These are
boundary checks, not interception of transient mutations between boundaries.

Phase 2 #171 resolves the todo/subagents guard deferral from
[spec PR #170](https://github.com/nredd/pi-harness/pull/170), tracking
[#160](https://github.com/nredd/pi-harness/issues/160). Both Vitest configs now install the
shared guard and fixtures inject their homes instead of mutating `HOME`. Todo runs its full
390-test suite on Bun. Subagents keeps its native-scenario subset plus the guarded real-loader
gate; full Bun activation remains blocked by the unrelated workflow-runtime stack-line
failure [#174](https://github.com/nredd/pi-harness/issues/174). Its full Node suite is guarded.
No guard-related skip list or informational-only guard is used. See the current matrix,
boundary negative controls and package-addition procedure [here](verification-engines.md).
Python stays on pytest/uv/ruff/ty; dotfiles stays on dependency-free `node --test` as the
bootstrap exception. Istanbul consolidation is phase 3, not part of this producer change.

Toolchain: Node from `.node-version`, npm from `packageManager`, Bun from `.bun-version`, uv `0.13.1`
(Python from `.python-version` via uv). Every action is pinned to a commit SHA.

Required checks on `main`, twelve contexts:

- `owned (ubuntu-24.04)`, `owned (macos-14)` and `owned (wsl2)`
- `contracts (ubuntu-24.04)`, `contracts (macos-14)` and `contracts (wsl2)`
- `stack (ubuntu-24.04, personal)`, `stack (ubuntu-24.04, local)`, `stack (macos-14, personal)`, `stack (macos-14, local)`, `stack (wsl2, personal)` and `stack (wsl2, local)`

Dropping a cell from a matrix would leave its context pending forever, which is why the cells that no longer test anything stay as bypass cells.

The `macos-14` in these names is a stable check context, not the OS version: GitHub retired that image, so the cells run on `xcode-27` (macOS 27, GitHub names new images after the Xcode major) via `matrix.runner`. Renaming them would need a ruleset change.

The historical nine-context receipt remains in `scripts/tests/fixtures/merge-pr-135.json`, unchanged. Tests explicitly add synthetic replacement matrix records; they are not hosted execution evidence.

The twelve jobs are the configured required checks of ruleset `main required checks` (id `25524267`, `integration_id` 15368 each); `Promote stack` reads them from `GET /repos/nredd/pi-harness/rules/branches/main`, then attests and releases `stack/<sha>` (`docs/stack-promotion.md`). `migration-review/standards` and
`migration-review/spec` are no longer required. Reviews are our process, not a CI gate:

- Run separate Standards + Spec reviews on the exact final HEAD; any HEAD change invalidates both
- `scripts/merge-pr.sh` is the tracked source; `scripts/merge_pr_checks.py` owns its read-only CI
  predicate. Invoke the helper from an exact reviewed checkout. It validates distinct reviewer IDs,
  exact final-report HEAD and axis, unresolved-revision errors, receipt posting and
  `--match-head-commit`. Each reviewer's **final assistant report** must begin with these literal
  lines (use `Axis: Spec` for the other axis), then its normal `Checked:` and `Findings:` sections:
  ```text
  Axis: Standards
  Reviewed HEAD: <full-40-character-reviewed-sha>
  ```
  Missing, duplicate or conflicting declarations refuse. A SHA in an earlier request, tool call or
  incidental prose is not a receipt. Git diagnostic detection requires explicit boolean `isError`
  metadata: successful source reads/diffs may quote every failure pattern without invalidating the
  review. An actual failed unresolved-revision result blocks even if a later call succeeds. Missing
  or malformed Git-result status/content and reader errors fail closed. Renew the review rather than
  editing a transcript. The unmanaged
  `~/code/pi-harness-builds/merge-pr.sh` is a distribution copy, not source. Only after this PR is
  reviewed and merged may the parent copy **both** scripts together from the merged revision into
  that directory. Do not activate an unreviewed copy or change managed Pi config
- The helper gates **all** reported checks, including optional fork jobs, not just required contexts.
  It independently verifies every ruleset context against its bound app and reviewed SHA. Missing,
  pending, failed and current cancelled checks refuse. `SKIPPED` remains accepted for non-required
  conditional jobs
- A zero-step completed/cancelled literal CI matrix placeholder (`owned`, `contracts`, `stack`)
  is stale only with a later completed/successful execution of the same workflow ID/path, event,
  PR/head/base (including repository identity), Actions app and SHA. All twelve expected expanded
  matrix cells must individually succeed. The latest workflow execution must qualify; an intermediate
  green run cannot hide a later cancellation. Ordering uses `run_number`, then `run_attempt`, never
  timestamps or API page order. Evidence is fully paginated and validated as strict Pydantic records;
  missing, malformed or ambiguous evidence refuses.
  The bounded matrix contract test must change alongside any CI matrix change
- Bootstrap this helper's own PR without replacing the scratch copy: after independent Standards +
  Spec reviews of its final HEAD and existing hosted checks are green, invoke its reviewed tracked
  helper directly from the candidate worktree:
  Install the existing locked integration environment (`uv sync --locked` in `integration/`)
  for Pydantic evidence validation. Select trusted absolute executables and the actual transcript
  storage directory explicitly; there is no PATH-based or workstation-specific fallback.
  The shell uses `/bin/bash` and absolute native `ls`, `wc`, `dirname`, `mktemp` and `cat` paths;
  embedded readers resolve transcript paths with `Path` and require regular files before reading.
  The poisoned-PATH regression covers every external utility, including gate-path selection:

  ```sh
  MERGE_PR_TRANSCRIPT_ROOT=<absolute-transcript-store> \
  MERGE_PR_GH=/opt/homebrew/bin/gh \
  MERGE_PR_PYTHON=$HOME/code/pi-harness-merge-helper/integration/.venv/bin/python \
  bash ~/code/pi-harness-merge-helper/scripts/merge-pr.sh \
    <helper-pr> <full-reviewed-head> <standards-task-id> <spec-task-id> \
    <gate-history-file> nredd/pi-harness
  ```
  This uses real green checks and the same receipt/expected-head enforcement, not a bypass.
  Any branch update invalidates both reviews. Refresh the distribution copy
  only after that reviewed merge. This procedure does not authorize merging router PR135,
  publishing packages, or activating live configuration
- `forks.yml` is path-filtered and not a required protection check; when triggered, the remaining core Gitlink job must pass before merging

Flake policy (migration plan section 7):

- A new correctness failure blocks
- A documented, isolated flake may get ONE fresh rerun of the whole failed job, only when nothing else
  failed. The rerun must pass. Both attempts stay in the run's attempt history; name the flake in the PR
- Known timing-sensitive suites: session-kit `monitor` and `diff` reaping, dev-tools kill escalation,
  core `chord`/`durable` 5 s timeouts. They were green alone and flaky on a loaded laptop
- Subagents' genuine manager-reload fixture also includes synchronous TypeScript preparation and child
  imports inside its 5 s test deadline. PR #138's macOS failure reported that deadline at 5597 ms
  ([here](https://github.com/nredd/pi-harness/actions/runs/40369078357/job/121734701111)). Controlled
  compiler/import delays reproduce the same timeout on the unchanged `origin/main` source while the
  child passes every budget assertion and exits successfully. Vitest checks elapsed time even after
  a synchronous test returns. Compile each source once and write its output to two physical ESM trees;
  the test pins that operation count and retains distinct managers, shared waiters and final zero usage.
  Neither the 5 s test deadline nor the 10 s child watchdog changes. This does not authorize a rerun
- Never rerun until green, never relabel NOT RUN as a pass

Both assembled stacks use `npm:@gotgenes/pi-anthropic-auth@3.4.3`, not the retained auth Gitlink.
`test_auth_transport.py` records direct Anthropic and `router/default` OAuth requests: native bearer
and Pi user agent, exact versioned billing block, section-shaped system prompt retained in `system[]`
and unchanged first user text. API-key and unconfigured custom-provider requests stay unshaped.
Refresh persistence/refusal and the missing-Node-preload fail-closed branch remain covered. No live
subscription is used. Explicit pi-ai compat dispatch and legacy loops without `streamFn` bypass the
provider wrapper; compaction/modelRegistry coverage is upstream-documented, not asserted here.

The `stack` job explicitly selects `integration/scenarios/test_*.py` plus
`integration/scenarios/tui/test_footer_resize.py`, marked `stack`, under xdist `--dist loadfile`.
No unported non-boundary Python scenarios remain. Package-native suites and `integration/inprocess/`
own the ported assertions; the destination ledger is [here](verification-rebuild.md).
The thirteen historical `DOTFILES` rows belong to dotfiles, not a distribution check. Eleven
remain doctor checks; the two REA rows were retired in `nredd/dotfiles#58` and replaced with
absence/cleanup regressions in dotfiles' `tests/rea-retirement.test.mjs`. See
[here](../integration/README.md) for inputs, package sets and deliberate headless exclusions.

Tap and profile pin bumps require green CI on the candidate stack, not local `pi-harness-e2e make verify`.
A correctness failure blocks promotion; the existing one-fresh-whole-job-rerun policy applies unchanged.
`stack` still tests the released Homebrew-shaped Node bundle. Fork release `v1.3.0-nredd.8`
publishes the coding-agent and pi-tui npm tarballs, no standalone assets. Each running `stack` cell also builds the exact
Gitlinked source using `.bun-version` (1.4.4), the official `scripts/build-binaries.sh`, and frozen
release model data with `build:offline`. It does not depend on a future standalone release, commit
binaries, or test a Node wrapper in place of the compiled executable.

Bun scope:

- Native execution on `xcode-27`, macOS 27 (darwin-arm64) and `ubuntu-24.04` (baseline linux-x64).
  Each running cell builds once for its own stack
- `--runtime bun-standalone` skips only the seven marked auth dispatch/refresh cases from
  `integration/scenarios/test_auth_transport.py`: Bun ignores the `NODE_OPTIONS --import` redirect
  and egress/readiness preload in `harness/anthropic_mock.py`. The missing-preload refusal case runs
  on both runtimes. Skip reasons appear in pytest and JUnit before fake auth fixtures can dispatch.
  Separate candidate auth steps pass `--bun-auth-adapter` for each stack on the same compiled core:
  `BUN_OPTIONS --preload` loads the shared redirect before entrypoint startup, while Node retains
  its original hook. These steps retain the actual shaping/refresh/refusal assertions and write
  `standalone-auth-personal.xml` / `standalone-auth-local.xml`. This is an explicit receipt lane,
  not a blanket unskip or a claim that those hosted executions passed. Default skips remain until
  receipts demonstrate compiled-core acceptance. The small native fixture in infrastructure units
  proves hook admission and failures only, not assembled-stack behavior
- No other selected D/E case uses preloads, scaled timers or `--expose-gc`. Clock-driven behavior
  moved to native suites. `providers/fast_timers.mjs` is no longer used by selected D/E scenarios;
  `harness/probe.py`'s `--expose-gc` is used only by excluded `scenarios/bench/test_render.py`
- The adapter blocker is [here](https://github.com/nredd/pi-harness/issues/14). Previous references
  to #58 are stale: no such issue exists in this repository. The timer migration removed one
  dependency, not the remaining auth transport interception requirement
- NOT RUN: linux-arm64 (no `ubuntu-24.04-arm` job added), darwin-x64, Windows, packed contracts
  hosted by the standalone, quiet-runner benchmarks, live credentials and desktop/TCC helpers.
  REA is retired, not an outstanding standalone acceptance requirement.
  Source-built D/E coverage is not published-binary acceptance or a completed Bun checklist

Capacity: full PR CI requests three macOS jobs (`owned`, `contracts`, `stack (macos-14, local)`) and two Windows jobs only with WSL inputs. It used to request four of each, every run. Ubuntu now builds the standalone twice, once per stack cell, where it used to build once and run both stacks serially. Stack timeouts are 40 minutes. Linux ARM64 is omitted to avoid another build and two stack installs. Bun failures fail their own stack cell.

`.github/workflows/publish.yml`, pushes of tags matching `@nredd/*@*`:

| Job | Runs | Permissions |
| --- | --- | --- |
| `verify (ubuntu-24.04)` | `scripts/npm_release.py` validates package/version, tag commit ancestry on freshly fetched `origin/main`, and npm absence; installs, checks the selected package with pinned Bun, packs once, runs applicable contracts on those exact bytes, generates SHA-256/SHA-512 identity and release manifest, uploads the artifact | `contents: read` |
| `publish (ubuntu-24.04)` | Environment `npm`; downloads and validates the artifact, asserts/prints Node >=22.14.0 and npm >=11.5.1, publishes the verified tarball via trusted publishing; checks npm integrity, runs `npm audit signatures` in a one-package throwaway install, and binds the fetched DSSE provenance to the tarball, workflow, tag and commit. Matching existing bytes skip publication; different bytes fail | `contents: read`, `id-token: write` |
| `release (ubuntu-24.04)` | Creates a verified-tag GitHub release with the original tarball, checksum, identity and manifest attached | `contents: write` |

The jobs have bounded timeouts and per-tag concurrency without cancellation. No npm tokens, no rebuild
in publish, no manual dispatch. External trusted-publisher/environment/tag protections and failed-job
recovery are documented [here](releases.md#owned-npm-packages). Only a real tag-triggered publication
can prove the external OIDC binding, automatic provenance and registry acceptance end to end.

Not in CI yet: bench on a quiet runner, live `G` (deliberately never CI).
