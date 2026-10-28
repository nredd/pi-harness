# Bun 1.4.4 toolchain upgrade

Separate implementation of approved verification-spec D7 / phase 6. The published branch
plain-merged `origin/main` at `166e801a` in merge commit `8d0fe67f`, retaining #182's cheap
profile (`b51e1774`) and #192's todo coverage/home-launcher work (`166e801a`), after #171's
home injection. No rebase, reset or force push. Existing full-Bun compatibility gaps such as
#174 remain known; this is not a claim that the whole verification migration is complete.

This changes the build/test compiler and matching API declarations, not the installed user
Bun/Pi, Gitlinked core, npm package release selections, stack promotion or coverage policy.
No PR merge, publish, activation, timeout increase, assertion relaxation or failure-masking
retry is included.

## Candidate selection

Checked 2026-10-28 against both primary distribution channels, not inferred from the spec:

- GitHub `repos/oven-sh/bun/releases/latest`: `bun-v1.4.4`, published 2026-10-22T10:11:32Z
  ([here](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4)).
- `npm view bun dist-tags --json`: `latest=1.4.4`, `canary=1.4.4-canary.20261028.1`.
  Select the latest stable 1.4.x patch, not canary. `@types/bun` and `bun-types` also resolve
  to 1.4.4. The root and todo `.bun-version` plus todo's declarations/lock agree.
  Runtime revisions are `1.4.4+38afee6c8` and `1.3.14+0d9b296af`.
- Official `bun-darwin-aarch64.zip` SHA-256:
  `c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510`, matching the release
  asset digest and downloaded checksum list. Candidate lives only under the worktree's ignored
  `integration/artifacts/tools/`; old 1.3.14 is selected through `npm exec --package=bun@1.3.14`.
- Every CI `setup-bun` action already consumes root `.bun-version`; no duplicate CI literal.
  `scripts/tests/test_bun_toolchain.py` now guards this wiring, split pin and locked declarations.
  The declaration update adds `undici-types` as an upstream `bun-types` dependency; it was already
  present in the lock. No owned source API was changed.

Relevant release changes ([1.4](https://bun.com/blog/bun-v1.4),
[1.4.4](https://bun.com/blog/bun-v1.4.4)):

- 1.4 advertises Vitest with threads/forks and coverage; native `--isolate` resets globals,
  module registries and fake timers. These are Bun compatibility claims, not Vitest guarantees.
- `process.exitCode` changed from an `exit` listener is now honored (upstream #38229).
  `process.reallyExit()` no longer emits `exit` (#34997); callers needing listeners use
  `process.exit()`. This PR does not replace Pi shutdown with another exit API.
- 1.4.4 fixes `node:vm` context behavior relevant to jsdom/Vitest, native coverage accounting
  of skipped/resumed lines, constructors/function totals, and LCOV hit counts. Native coverage
  percentages can drop with unchanged code. It also fixes inspector precise-coverage ranges.
- Keep Istanbul and Node-primary decisions. Native Bun coverage still omits never-imported
  files and branch records in the fixture. Do not substitute native counters or V8 counters,
  raise budgets, merge engine counters or promote enforcement in this toolchain PR.
- Cached `os.homedir()` is unchanged. The spawn-time HOME launcher and injected fixture homes
  remain necessary. `NODE_OPTIONS` preload interception in standalone remains unsupported (#14).

## Boundary regressions and uncertainty

`integration/tests/test_runtime_exit.py` uses Node and the selected Bun as real subprocesses:
explicit exit, natural drain, stdin EOF and an exit-listener status override. It asserts exact
output, one exit event, the exact return code, empty stderr and a bounded deadline. The listener
case is red on 1.3.14 and green on 1.4.4. The public exit fixture alone has **7 pass / 1 fail
on old Bun, 8 pass / 0 fail on candidate**, including the Node rows. This is distinct from
the aggregate runtime/capability receipt (**9 pass / 3 fail old, 12 pass candidate**) and the
two additional pin/config checks (**14 focused tests pass on candidate**). None is a
native-crash reproduction.

`integration/tests/test_bun_capabilities.py` covers cached/spawn-time HOME, native module
isolation plus Date/fake-timer advancement, and fail-closed LCOV-only thresholds with a
never-imported file. The isolation fixture requires re-evaluation of a real module and a fresh
global in each file; running the same fixture without `--isolate` is a required failing
negative control. The threshold fixture requires passing assertions but nonzero coverage status. On 1.3.14 the timer and LCOV threshold tests fail; on 1.4.4 all pass.
The isolation assertions alone pass on both versions in this small fixture.

The exact Gitlinked core's unchanged `packages/codemode/test/worker-lifetime.test.ts` was also
run on Node with Bun available, one worker: 1.3.14 fails all three Bun process rows because the
exit event record is missing (**11 pass / 3 fail**); 1.4.4 passes **14 / 0**. Both complete in
about 14s. Exact frozen core Gitlink: `2bfb8e7c61d35167b09f8ce70693df39660fc197`;
candidate `1.4.4+38afee6c8`, old `1.3.14+0d9b296af`. Commands from the repository root:

```sh
root=$(pwd)
cd forks/pi
npm exec --yes --package=bun@1.3.14 -- node_modules/.bin/vitest run \
  packages/codemode/test/worker-lifetime.test.ts --maxWorkers=1
PATH="$root/integration/artifacts/tools/bun-1.4.4/bun-darwin-aarch64:$PATH" \
  node_modules/.bin/vitest run packages/codemode/test/worker-lifetime.test.ts --maxWorkers=1
```

The fixture is present in the initialized local submodule. Prerequisites are `git submodule
update --init forks/pi` and `npm ci --ignore-scripts` in that submodule; root `make install`
does not install fork dependencies. A limited reviewer checkout is not evidence of deletion.
These results are reused because the exact core/model/compiler inputs did not change when
main was plain-merged. This is a demonstrated API exit-event improvement, not proof that it
fixes #100/#108/#155/#178.

Known hosted evidence remains distinct:

- #155 run 40666549747/job 122742471639: macOS 14.8.9 Bun 1.3.14 segmentation fault at 0xC,
  `VirtualMachine.globalExit` / `process.exit`, after ordinary-session_start TUI output.
- #178 job 122744482131: RPC timeout with a Bun crash banner; the post-timeout -9 is Python's
  kill, not a normal exit. Downstream curl crash-handler errors do not implicate an extension.
- Prior read-only diagnosis produced 58 unchanged ordinary TUI/RPC passes on 1.3.14, no crash.
  This Mac runs macOS 27.2, not the hosted macOS 14 VM. Neither a same-host old/new pass nor
  the small red exit fixture proves a native-crash fix. Hosted reproduction is unresolved.

## Frozen-core build comparison

Historical comparison harness base `6d7b13cbf6ccbc67835455aed5ed89c032e622ab`;
core Gitlink unchanged by the later plain merge:
`2bfb8e7c61d35167b09f8ce70693df39660fc197` (`v1.3.0-nredd.7`). Clean independent submodule,
`npm ci --ignore-scripts`, release `@earendil-works/pi-ai@1.3.0` data including manifest,
never live model fetching. Model tarball SHA-256:
`5343e1639bf343bdc3344df3ad6c31c05a50b68bad07ac6bce10890d4b6b8a61`.

Local tools: Node 26.12.0, npm 11.20.0, uv 0.13.5 (CI requests 0.13.1), macOS 27.2 arm64.
Resource snapshots preceded compile/test workloads; 10 logical CPUs, 23-41% sampled CPU,
64-66% memory-pressure free. No active-agent listing capability was exposed by tool discovery;
process names were not used to attribute agents. Four builds and comparison workloads are
serialized, with at most two test workers, no synthetic load or retry-until-green.

Each build used the actual official script, alternating compiler versions:

```sh
PATH=<selected-bun-directory>:$PATH sh ./scripts/build-binaries.sh \
  --skip-install --offline-model-data --platform darwin-arm64 --out <unique-output>
```

All four builds exited 0. Two executable hashes per compiler match exactly:

| Compiler | Executable SHA-256 (both repetitions) | Archive A SHA-256 | Archive B SHA-256 |
| --- | --- | --- | --- |
| 1.3.14 | `fbf7d747a76184f23a13e0e417b6bea372770e862c94f38634b9e5a7c1b60fc0` | `6f66b893a5bb23f828ef564c9d29ee19f5bf56437f47be6c75d1cceee8cf920e` | `a64e1f8f4cfea5f5c933e9c37a08b61fa2192f7718b6eb8a9f46f0f774dc46e1` |
| 1.4.4 | `2228d24c2431d298a3765ba618b73e82657bf905304d7fe88097d8c36243c9af` | `f749ac4ea20a52925246462f7609fd4a0e79d0999ce7d573df927f28f791e631` | `05faad6d698e7d78029fa3f87cb423452418ae0d846466b2f625a0c4f8764e47` |

Per compiler, both archives contain the same 484 paths and identical bytes for every regular
file. All 484 entries have differing mtimes (tar checksums change too). Therefore executable
repetition is deterministic in this local sample, but archive byte determinism is NOT fixed;
#72/#84 remain open. Across compiler versions, paths still match and `pi/pi` is the only
regular file whose bytes differ; adjacent resources remain identical.
Both are Mach-O arm64. Executable size increases from 77,134,562 to 102,699,746 bytes
(about 33%); candidate signing is linker-generated ad hoc, without a TeamIdentifier, not
notarization. This is not an authenticated/reproducible release claim.

## Historical workload and gate results

The following old/new comparison ran on initial harness base `6d7b13cb`, before #192. It is
not a claim that later merge HEADs passed the same gates. The unchanged complete D/E command
was run once per compiler/stack, with two workers:

```sh
PI_BIN=<selected-build>/darwin-arm64/pi uv run --locked pytest \
  scenarios/test_*.py scenarios/tui/test_footer_resize.py \
  --stack stacks/<stack>.json --runtime bun-standalone -m stack \
  -n 2 --dist loadfile --log-cli-level=INFO --junitxml=<unique-receipt>
```

| Compiler | Local | Personal |
| --- | --- | --- |
| 1.3.14 | 32 passed, 7 skipped, 127.818s | 32 passed, 7 skipped, 129.610s |
| 1.4.4 | 32 passed, 7 skipped, 102.500s | 32 passed, 7 skipped, 118.381s |

This includes all 16 unchanged startup-mode cases, RPC EOF/monitor lifetime, TUI exit/status
and footer resize. All seven skips per stack are the existing auth/preload cases (#14);
missing-preload refusal still runs. Zero retries and zero local native crashes. Timings are
observations, not a performance gate or controlled speed comparison.

Execution receipts are in ignored `integration/artifacts/compare-*` and `/tmp/bun-upgrade-*`.
The final PR records hosted results; local evidence is not hosted CI.
No full migration is implied. On this historical base, several packages retained native Bun
subsets and #174 blocked full subagents activation; #162's coverage policy was absent.
#171 had supplied home injection. #192 is now merged: it retains the full todo HOME launcher
and explicit Istanbul inventory and records 408 todo tests / complete measured lines/functions.
That supersedes the old 390-test todo row below, not the core or old-compiler measurements.
There were no phase-2 version-scoped skips on the historical base to remove.
For manual full-suite coverage, preserve each workspace's installed Vitest version (5.0.3,
4.1.12 in subagents/todo) and compatible provider. Istanbul 5.0.3 is installed in an isolated
ignored tool prefix and linked into root `node_modules` only for this experiment. Subagents
keeps its existing 4.1.12 provider; todo receives an isolated matching 4.1.12 provider link.
A todo attempt with the root 5.x provider was invalid (`coverageFilesDirectory is required`),
not a Bun failure; its corrected receipts use the compatible 4.x pair. Initial `src/**/*.ts`
includes also produced empty reports for flat-layout todo/preset, so those are not evidence:
corrected includes name todo's five root modules plus locales/state/tool/view, and preset's
extensions/lib. Both corrections are identical across all three engines. Every engine gets the same source include, reporters,
config and worker bound (sampler one, others two), plus `reportOnFailure` to retain red-suite
counters. No coverage-tool dependency or producer/enforcement policy is shipped in this PR.
An initial scratch `npm install --no-save --package-lock=false` changed dependency hoisting
(including TypeScript 7 -> 6 and sampler resolution), invalidating its post-install gate/coverage
results. That driver was stopped; `npm ci --ignore-scripts` restored the locked tree before
collecting final `locked-*` receipts (corrected producer attempts are identified above). The
earlier four standalone stack runs used independent installed sandboxes and are unaffected.

Historical unchanged full-suite comparisons at `6d7b13cb` (`pass / fail / skip`, skips unchanged):

| Workspace | Node | Bun 1.3.14 | Bun 1.4.4 | LCOV files / lines / functions / branches, same denominators on all engines |
| --- | --- | --- | --- | --- |
| dev-tools | 379 / 4 / 0 | 357 / 26 / 0 | 360 / 23 / 0 | 22 / 1504 / 261 / 1557 |
| plan-mode | 539 / 0 / 0 | 535 / 4 / 0 | 539 / 0 / 0 | 34 / 2994 / 699 / 3155 |
| preset | 127 / 0 / 0 | 127 / 0 / 0 | 127 / 0 / 0 | 3 / 310 / 73 / 299 |
| resource-sampler | 39 / 0 / 0 | 39 / 0 / 0 | 39 / 0 / 0 | 4 / 372 / 56 / 312 |
| session-kit | 718 / 0 / 0 | 717 / 1 / 0 | 718 / 0 / 0 | 51 / 3536 / 824 / 3167 |
| subagents | 3448 / 0 / 8 | 3448 / 1 / 7 | 3448 / 1 / 7 | 75 / 7161 / 1423 / 6820 |
| subscription-router | 206 / 0 / 0 | 206 / 0 / 0 | 206 / 0 / 0 | 8 / 566 / 129 / 637 |
| todo | 390 / 0 / 0 | 390 / 0 / 0 | 390 / 0 / 0 | 18 / 965 / 222 / 986 |
| inprocess | 91 / 0 / 0 | 91 / 0 / 0 | 91 / 0 / 0 | 9 / 265 / 86 / 94 |

Per-file inventories and line/function/branch denominators match, not just aggregate totals.
No candidate-only failing test IDs were observed. Candidate removes the old four plan watchers,
one date-axis test and three SSH-host tests. Remaining failures are not hidden: dev-tools has
19 readonly ChildProcess test-double failures on both Buns, plus the same four Node/Bun failures
(three nextest assertions and an isolated-HOME Python missing-tool expectation). Subagents
retains the authored stack-line assertion failure on both Buns (#174). These are existing
full-suite compatibility gaps, not new candidate failures or permission to mark every package
green. Fresh merged-source results are recorded separately below/in the PR.

A separate two-file Istanbul fixture includes an unimported function. The committed
`test_istanbul_counters_match_both_engines` unit now reuses the locked subagents Vitest/provider
pair without installing dependencies, verifies the actual worker engine/version through a file marker,
and enforces the inventory, exact counters and identical Node/Bun LCOV. Node / old Bun / candidate
also emit byte-identical LCOV in the three-engine experiment: `LF=4 LH=1 FNF=3 FNH=1 BRF=2 BRH=1`, with `never.ts` present and
zero hits. The native threshold fixture still omits that file and branch records. Package hit
counts differ on engine-specific paths (for example plan-mode lines 2803/2994 on Node,
2799/2994 on old Bun, 2801/2994 on candidate); stable denominators do not imply equal execution
or 100% coverage. No threshold/enforcement change or complete repository coverage claim.

Recorded gates on the earlier checkpoint (not the plain-merged HEAD):

- `make install`: pass, including root override verification; core installed separately and clean.
- `make check`: RED, three pre-existing dev-tools Node cargo/nextest assertions (380 pass).
  npm continued the other workspace checks. Do not describe the whole repository gate as green.
- `make check-scripts`: Ruff/ty/Biome/tsc clean, 695 pytest + 8 Node import-audit tests pass.
- `make check-integration`: Ruff/ty/Biome/tsc clean, 1327 pytest + 15 Node probe tests passed before review; the new counter unit adds one case.
  Final exact-HEAD receipt is recorded in the PR after rerunning the complete gate.
- `make check-benchmark`: pass, 91 units, 92.98% against unchanged 90% floor, pinned Codex
  0.154.0 with disposable Codex home/cache. This is the unit gate, not timing benchmark F.
- New focused regression/config tests: 14 pass on candidate. Old Bun: 9 pass / 3 fail for
  runtime/capability tests (listener status, Date advancement, LCOV-only enforcement).
- Official compiled codemode smoke: `PI_CODEMODE_BINARY_SMOKE_OK` on both compilers.
- Hosted Linux/macOS jobs, packed contracts, WSL2, live providers, REA and desktop helpers:
  not claimed by these local results. Exact PR HEAD CI/review receipts belong in the PR.

## Plain-merged checkpoint and fresh receipts

Only `~/code/bun-upgrade-pr` was changed. The plain merge had no conflicts and preserved Bun
1.4.4 pins/API declarations, the cheap profile, and todo's full suite/HOME launcher/Istanbul
inventory. Released changelog entries and old measurement inputs are not rewritten.

Run `npm ci --ignore-scripts` in the worktree before the Python capability/counter units;
`uv sync --locked` in `integration` provides their Python tools. The counter fixture requires
the locked workspace Vitest/provider pair. Missing dependencies must fail fast, not skip, and
the 30s fixture timeout remains unchanged. Embedded JavaScript uses readable `dedent` templates
without changing assertions, control flow or expected counts.

Reuse: the two old-compiler builds/stacks, repeated-build metadata and core exit-fixture
measurements above. The frozen core Gitlink, model tarball and candidate compiler are unchanged,
so the candidate executable with SHA-256 `2228d24c2431d298a3765ba618b73e82657bf905304d7fe88097d8c36243c9af`
is reused, not pointlessly rebuilt. New local-stack installs are required because merged
workspace subagents/todo/router sources changed. Candidate local and personal D/E runs use new
pytest installation directories; personal still tests its explicit published pins, local the
current workspace sources. No old-compiler full-stack rerun is needed for a historical label.

After the final fixture/docs edits, collection reports **1328 integration tests and 696 script
tests**; the focused candidate set passes **14 tests**. The formatted old runtime/capability
set still reports **9 pass / 3 fail**, including the public-exit **7 / 1** baseline. These are
collection/focused receipts, not a claim that the remaining full gates passed.

Fresh candidate Node/Bun package suites, todo's root-Vitest Istanbul/HOME launcher, integration
and scripts lints/types/units, and the root gate run after final docs/tests. Results and test
counts are bound to the final commit in the PR, not borrowed from the pre-merge table.
`make check`'s three local cargo assertions remain a known baseline until separate #155; #174
remains a known Bun authored-line failure. Neither is hidden by skips, retries or softer assertions.

Hosted Ubuntu/WSL receipts previously posted for `3869478` remain evidence for that HEAD only.
A new merge/edit HEAD requires its own status: queued macOS checks are not green evidence, and
no CI rerun is dispatched just to fish for green. Review references supplied by the owner are
`cb9158e5` (Standards) and `fb7013d0` (Spec); the requested reconciliation is a plain merge,
never rebasing a published branch. Durable final-head gate/status receipts belong in the PR.
No activation, release, publication or PR merge. Native hosted-macOS crash reproduction remains
unresolved; the upgrade is not a proven crash fix.
