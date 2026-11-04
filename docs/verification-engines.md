# Verification engines

Phases 1 and 2 of [spec PR #170](https://github.com/nredd/pi-harness/pull/170), tracking
[#160](https://github.com/nredd/pi-harness/issues/160). Vitest is the owned TypeScript tool;
Node stays primary because it ships today. Bun remains required for the standalone target.
The phase 1/2 migration did not change coverage providers, thresholds or required check names.
The separate approved D7 toolchain upgrade selects Bun 1.4.4; evidence and remaining gaps are
[here](bun-upgrade.md).

| Workspace | Node | Pinned Bun 1.4.4 |
| --- | --- | --- |
| `subscription-router` | Full Vitest + guard | Full Vitest + guard |
| `preset` | Full Vitest + guard | Full Vitest + guard |
| `resource-sampler` | Full Vitest + guard, one worker | Full Vitest + guard, one worker |
| `integration/inprocess` | Full Vitest + guard, spawn-time home | Full Vitest + guard, spawn-time home |
| `session-kit`, `plan-mode`, `dev-tools` | Existing full Vitest | Existing native Bun subsets plus spawn-time-home Vitest home-forwarding canaries |
| `todo` | Full Vitest + guard | Full Vitest + guard |
| `subagents` | Full Vitest + guard | Native-scenario subset + guarded real-loader gate; full suite pending [#320](https://github.com/nredd/pi-harness/issues/320) |
| `computer-use` | Full Vitest + guard, one file at a time; `check-linux-native`, `check-macos-helper-live`, `check-linux-live` stay scripts (#347 follow-up) | Not run |
| `integration/probes`, `scripts/import_audit.test.ts`, `scripts/check-biome-paths.test.mjs` | Vitest + guard, V8 coverage (#347) | Not run (import audit remains Node-only) |

Owned Vitest configs cap workers at two (sampler and computer-use: one), including direct Node/Bun
Vitest runs. These are per-gate defaults, not a host-wide concurrency limit.
The #105 source audit, regression loop and remaining acceptance criterion are
[here](test-worker-budgets.md).

Python stays on pytest, uv, ruff and ty. The separate dotfiles repository stays on dependency-free
`node --test`: its bootstrap gate runs before dependency installation. Vitest benches stay on
Node. Coverage PR #162 integrates these producers after this PR, as specified in the handoff
below; broader Istanbul consolidation remains phase 3.

## Home boundaries

`integration/inprocess/verification/home-guard.ts` exports the reusable assertion;
`home-setup.ts` installs it at worker setup, before each test and after each test on **both**
engines. A mismatch fails with the offending test file and an explicit injection fix. A missing
`HOME` also fails. This is a boundary guard, not a filesystem sandbox: a test can temporarily
mutate and restore HOME between boundaries without detection. Do not use it to justify runtime
HOME mutation. In particular, an earlier fixture cleanup can restore HOME before the afterEach
check. Production paths should receive explicit fixture directories instead.

Bun caches `os.homedir()` and ignores runtime HOME changes on both 1.3.14 and 1.4.4.
`scripts/run-vitest.ts bun` therefore launches `bun --bun vitest run` with HOME, USERPROFILE and
XDG config set to a fresh temporary directory **before process start**, removing it on exit.
It preserves the child's failing exit status, including spawn failure, and never selects test
files. The inprocess Node suite uses the same launcher with `node`. Its fixtures retain
independent Pi/XDG directories without mutating HOME. This prevents reads of the owner's home
while keeping the guard active; it does not isolate unrelated absolute paths or credentials
explicitly supplied through other environment variables.

The `bun` engine also owns the Bun signal's instrument. After the package's own arguments it
appends `--coverage`, the Istanbul provider, the `text` and `lcov` reporters and `coverage/bun`.
Only the exact argument `--coverage.enabled=false` opts out, and then it appends nothing, so a
canary cannot overwrite another report. The `node` engine never appends coverage arguments.
`scripts/tests/test_coverage_producers.py` pins that contract by running the real launcher.

Unit tests cover matching, mismatched and missing homes, the six-workspace wiring contract,
and launcher failure/cleanup/argument forwarding. Two subprocess fixtures pin the beforeEach
and afterEach boundaries independently, using canonicalized symlinked temporary homes:
Bun/Vite's bundled config loader otherwise fails through macOS `/var` aliases before reaching
the guard. A subprocess regression runs the real
`todo.invalidation.test.ts` with todo's injected setup and this guard under Bun: it must pass
without mutating HOME. The boundary negative controls still prove mismatches fail closed.
`support.test.ts` pins the fixed launch home and independent fixture paths on both engines.

## jiti cache

Pi's extension loader leaves jiti's transform cache at its default, `$TMPDIR/jiti`. jiti names each
entry after the source's absolute path and never evicts, so every fixture extension a test writes
into a fresh `mkdtemp` dir left a file behind for good: one fleet Mac reached ~39k files / 489MB
([#352](https://github.com/nredd/pi-harness/issues/352)). Test runs therefore set
`JITI_FS_CACHE=false`; spawned probes inherit it. jiti 2.7 reads the variable as a boolean only, so
a per-run cache path is not available without a `TMPDIR` override. Fixture paths are fresh per
run, so the cache never hit there anyway. Real `pi` keeps the cache: its extension paths are
stable install paths, one entry each, rewritten in place.

`scripts/run-vitest.ts` sets it for every child. Every script that launches `vitest` or `bun test`
directly carries an inline `JITI_FS_CACHE=false` prefix instead. Those prefixes are a stopgap: they
go away as the scripts move onto `run-vitest.ts`
([#347](https://github.com/nredd/pi-harness/issues/347),
[#320](https://github.com/nredd/pi-harness/issues/320)). Routing them through the launcher now
would also change their `HOME` isolation, which is #347's scope.

Not covered, by design: ad-hoc `npx vitest` / `bun test` runs typed by hand, and
`packages/subagents/test/perf/ab.mjs`, a manual A/B tool that spawns `npx vitest bench` in two
trees and inherits whatever the operator's shell sets.

`launcher.test.ts` resolves Pi through its package root export and loads a real `.ts` extension
with `discoverAndLoadExtensions` under a private stand-in `TMPDIR`. It proves the same load writes
`jiti/` outside the launcher, then proves the launcher run writes nothing. Its wiring test scans the
root and every workspace `package.json`, splits scripts on `&&`, `||`, `;` and `|`, matches
`vitest` or `bun test` as the command head (bare or through `npx`, `bunx`, `bun x`, `npm exec`),
fails on any match without the prefix, and pins the exact set of direct launchers. Adding one is a
deliberate edit there and here.

## Phase 2 home injection

The todo/subagents guard deferral is resolved by #171. Both Vitest configs install the shared
setup on both engines; fixtures inject disposable homes instead of mutating HOME. Todo's
`test:bun` uses the full-suite launcher with `.vitest.config.ts` (390 tests).

Subagents retains its native-scenario subset plus the real-loader Vitest gate through the
spawn-time-home launcher. `session-kit`, `plan-mode`, and `dev-tools` likewise retain their
native subsets while their injected-home canaries run through `scripts/run-vitest.ts bun`.
`session-kit` also runs its home-only factory canary through `scripts/run-vitest.ts node`, and
leaves it out of its ordinary Node Vitest run and native Bun scenario list. On both engines the
launcher installs disposable `HOME`/`USERPROFILE` values before the canary imports the SDK, so
the mocked `node:fs` SSH probe works and Bun never starts with the real home.
Switching subagents to the full Bun suite is a later slice of
[#320](https://github.com/nredd/pi-harness/issues/320), gated on macOS minutes. These canaries
pass `--coverage.enabled=false`, so the launcher appends no Bun coverage arguments to them.
The guard is active for its full Node suite and any Bun Vitest invocation, including
the real-loader exact-equality ambient-access canary. No tests are skipped to accommodate the
guard; native `bun test` scenarios do not consume Vitest setup files.

## Coverage handoff

Merge #175 first. Then update [#162](https://github.com/nredd/pi-harness/pull/162)
(`coverage-phase0`) against the merged source; phase 1 deliberately adds no coverage flags.
The four phase 1 full Bun producers must keep the entry point `node ../../scripts/run-vitest.ts bun`
and pass Vitest options through it, not restore native `bun test`. Phase 2 adds todo through
the same entry point with `--config .vitest.config.ts`. Since #320 the launcher appends the
coverage arguments itself, so each `test:bun` carries only its package arguments:

```sh
node ../../scripts/run-vitest.ts bun                              # router, preset, inprocess
node ../../scripts/run-vitest.ts bun --maxWorkers=1               # resource-sampler
node ../../scripts/run-vitest.ts bun --config .vitest.config.ts   # todo
```

Keep the sampler's `--maxWorkers=1`. Install the Istanbul provider version compatible with the
pinned Vitest. Istanbul remains the provider on Bun 1.4.4; do not substitute the V8 provider or
Bun-native coverage flags. Both `text` and `lcov` reporters are mandatory. Set explicit
per-signal source inventories and matching instrumentation includes in #162, including
never-imported files where full-source coverage is claimed; test counts alone are not source
coverage. Expected reports, relative to the repository root:

- `packages/subscription-router/coverage/bun/lcov.info`
- `packages/preset/coverage/bun/lcov.info`
- `packages/resource-sampler/coverage/bun/lcov.info`
- `integration/inprocess/coverage/bun/lcov.info`

Bun signals for `preset`, `subscription-router` and `todo` are **enforced** at 0/0 on both OSes
since #320; the rest stay **report-only** with their reasons and per-OS references. Primary
signals stay enforced. Changing producers is not an enforcement promotion, permission to merge engine
counters, or permission to raise budgets. The three promotions rest on #320's own hosted macOS
and Ubuntu artifacts, recorded [here](../coverage/receipts/bun-enforced.md).

On that rebase, #162 must also inventory `scripts/run-vitest.ts` and the new
`integration/inprocess/verification/*` sources, specifically executable `home-guard.ts` and
`home-setup.ts`, plus the new router/sampler Vitest configs. Use measured/pending declarations
or exact reasoned verification-helper classification as appropriate under `docs/coverage.md`;
conventional `*.test.ts` files remain tests, not production coverage exclusions. Do not let
these new files disappear from the repository source-classification scan. That inventory
cannot be added here: `coverage/policy.json` is not on main yet and belongs to #162.

## Add a package

1. Run its unchanged full Vitest suite on the pinned Bun, on macOS and Linux. Fix engine
   differences instead of weakening assertions or inflating timeouts.
2. Add `home-setup.ts` to its Vitest `setupFiles`, retaining existing setup/config behavior.
   Eliminate runtime HOME mutation that crosses guard boundaries; inject fixture paths.
3. Set `test:bun` to `node ../../scripts/run-vitest.ts bun` plus package arguments only (retain the
   sampler's worker limit). The launcher owns the coverage arguments; do not restate them.
   Keep it in the package's `check`, hence `make check-ts` and both existing `owned` cells.
4. Extend the wiring regression test and this matrix. Record per-OS counts and the launcher's
   timings in the PR; hosted output is in the existing job summary. No new jobs are needed.
5. Coverage inventory/provider/enforcement changes require the separate coverage policy review.
   A green full Bun suite alone does not flip a signal to enforced. Promotion needs the PR's own
   hosted macOS and Ubuntu artifacts at 0/0 (or the measured floor), as in #320.
