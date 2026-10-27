# Verification tool spec (#160)

Status: proposal for review. Nothing here is ported, pinned or wired yet. Measurements are from
`origin/main` `f2255c1`, macOS arm64 only, on a loaded laptop (load average 5-23), Node `26.12.0`,
Vitest `5.0.3`, pinned Bun `1.3.14` (official `bun-darwin-aarch64.zip`, SHA-256
`d8b96221...2652620` checked against `SHASUMS256.txt`) and Bun `1.4.4` (newest stable, released
2026-10-22, [here](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4)). Linux was NOT
measured. Timings are indicative only. Commands to reproduce are in the appendix.

TL;DR:

- ONE tool for owned TypeScript: **Vitest** (tests, coverage, benches), executed on **both
  engines**: Node (`vitest run`) and Bun (`bun --bun vitest run`). Not `bun test`
- Measured: the full Vitest suites already run under Bun with zero rewrites. 4 of 9 workspaces
  are fully green on both Bun versions. The remaining 49 failures on Bun 1.4.4 (46 Bun-only) are
  genuine Bun-vs-Node behavior differences that the `bun test` subsets never exercised
- Coverage: **Istanbul** everywhere. Its counters are engine-independent (identical denominators
  on Node, Bun 1.3.14 and 1.4.4), it counts never-imported files and it has branches. Bun's native
  coverage has no branches and no unimported-file include, on 1.3.14 *and* 1.4.4
- Python stays (pytest, `uv`, `ruff`, `ty`). `dotfiles` stays on `node --test`, documented exception
- Production engine today is **Node** everywhere. Bun standalone is CI-only. So both engines are
  required, and Node stays primary until the standalone actually ships

## 1. Goals, non-goals, decision criteria

Goals:

- One verification tool per language wherever possible: tests, coverage and benches
- Tests run on every engine a package actually ships on
- One coverage definition that plugs into `scripts/coverage_accounting.py` / `coverage/policy.json`
  (PR #162, in review) and can reach the 100% gate without per-tool accounting

Non-goals:

- Porting anything in this PR, changing the pinned Bun, or renaming required checks
- Rewriting frozen historical artifacts (`benchmarks/comparison`, migration plan section 1)
- Making the workstation Node-free (migration plan section 5: "Node remains a declared prerequisite")

Decision criteria, ranked:

1. Catches defects on the engine that ships (section 8). A tool that only runs on a non-shipped
   engine fails this outright
2. Coverage is complete-source and fail-closed: unimported files count, thresholds cannot be
   bypassed by reporter choice, counters are stable across engines and versions
3. Rewrite cost and risk of weakening existing assertions (5,708 Vitest tests today)
4. Works on the pinned Bun `1.3.14`; a Bun bump stays its own toolchain PR
5. CI cost inside the existing `owned` jobs (zero new required checks)

## 2. Inventory

Test counts: Vitest on Node, this checkout. API counts: `grep -rhoE '\bvi\.<api>\b'` over each
directory, excluding `node_modules`/`dist` (script in appendix). "Raw `bun test`" is the full
directory under `bun test` with no changes (coverage-baseline task, Bun 1.3.14). "Vitest on Bun"
is `bun --bun vitest run` with the package's own config.

| Dir | Runner(s) today | Tests | `vi.mock` / `importActual`+`importOriginal` / `hoisted` | async timers / `useFakeTimers` / `waitFor` | `setConfig` / `stubEnv` / `resetModules` | Config features Bun's runner lacks | Raw `bun test` fail | Vitest on Bun fail 1.3.14 / 1.4.4 |
| --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| `packages/subagents` | Vitest (Istanbul cfg), `test:bun` 4 files, `vitest bench`, `test/perf/ab.mjs` | 3278 + 7 skip | 86 / 41+20 / 6 | 91 / 47 / 70 | 14 / 3 / 2 | `server.deps.inline`, `resolve.dedupe` | 390 | 12 / 12 |
| `packages/session-kit` | Vitest, `test:bun` scenarios | 711 | 0 / 0 / 0 | 48 / 13 / 1 | 0 / 0 / 0 | none | 53 | 1 / 0 |
| `packages/plan-mode` | Vitest, `test:bun` 4 files | 539 | 0 / 0 / 0 | 0 / 0 / 2 | 0 / 0 / 0 | custom `runner` (timeout-cap policy), `globalSetup`, `setupFiles`, `env` | 32 | 4 / 0 |
| `packages/todo` | Vitest (`.vitest.config.ts`), `test:bun` 1 `bun:test` file | 387 | 1 / 0+2 / 1 | 3 / 3 / 1 | 0 / 0 / 1 | `resolve.alias`, `setupFiles`, `unstubGlobals`/`clearMocks`/`restoreMocks` | 3 | 15 / 15 |
| `packages/dev-tools` | Vitest, `test:bun` scenarios | 383 | 1 / 0+2 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | none | 8 | 25 / 22 (3 shared with Node) |
| `packages/subscription-router` | Vitest, `test:bun` scenarios | 197 | 1 / 0+1 (param named `original`) / 0 | 23 / 10 / 15 | 0 / 0 / 0 | none | 24 | 0 / 0 |
| `packages/preset` | Vitest, `test:bun` = all of `test/` | 127 | 0 | 0 | 0 | none | 0 | 0 / 0 |
| `packages/resource-sampler` | Vitest `--maxWorkers=1`, `test:bun` 1 file | 22 | 1 / 0 / 0 | 0 | 0 | none | 1 + load errors | 0 / 0 |
| `integration/inprocess` | Vitest + `bun test .` | 64 | 0 | 0 | 0 | none | 0 | 0 / 0 |
| `packages/computer-use` | `tsx`/`node` check scripts | n/a | n/a | n/a | n/a | not a test runner | n/a | NOT RUN |
| `integration/probes` | `node --test` (2 files) | 15 | `node:test` | | | | 1 (`bun test`) | n/a |
| `scripts/import_audit.test.ts` | `node --test` | 8 | `node:test` | | | | 8 (`bun test`) | n/a |
| `scripts/`, `integration/` | pytest | 272 / 322 + 31 scenario fns | | | | | n/a | n/a |
| `benchmarks/comparison` | pytest + pytest-cov 90 (branch) | 81 | | | | | n/a | n/a |
| `dotfiles/tests` | `node --test` (other repo) | 285 | `node:test` | | | | 9 (1.4.4) | n/a |

Other usage: `vi.fn` 1498, `vi.mocked` 549, `vi.advanceTimersByTime` 62, `vi.spyOn` 74,
`vi.getTimerCount` 18, `vi.setSystemTime` 6. Snapshots (`toMatchSnapshot`/inline/file): 0.
Custom reporters: none. Coverage config: only `packages/subagents/vitest.config.ts` (Istanbul,
`src/**/*.ts`); PR #162 adds the rest. `process.env.HOME =` assignments in test code: 60.
Factory-argument counts match by name, so a differently named `importOriginal` is undercounted.

Vitest-on-Bun failures, classified (logs `/tmp/vr-*-bun.txt`, `/tmp/vr13-*.txt`):

| Package | Failing files | Cause | Real defect class? |
| --- | --- | --- | --- |
| `subagents` | `custom-agents` (9), `skill-loader` (2) | Bun's `os.homedir()` ignores runtime `HOME` changes (repro below). Tests point `HOME` at a temp dir; source calls `homedir()` and reads the REAL `~/.agents` (`expected 8 to be 1`) | Yes, and a hermeticity hazard. `src/invocation-config.ts:84` already works around it |
| `subagents` | `workflow-runtime` (1) | reported script line numbers differ under JSC | Yes, user-visible error locations |
| `todo` | `config`, `todo-overlay.*`, `todo.guidance` (15) | same `homedir()` behavior via `.test-support/setup.ts` | Yes, same hazard |
| `dev-tools` | `core/process-lines` (18), `core/process` (1) | `child.stdout = new PassThrough()` throws `Attempted to assign to readonly property` on Bun's `ChildProcess` | Test-double only, rewrite the fake |
| `dev-tools` | `cargo/tools` (3) | also fails on Node locally (cargo-nextest, known from the baseline) | Not Bun |
| `session-kit` (1.3.14 only) | `stats/ticks` (1) | date-axis label, fixed in 1.4.4 | Bun 1.3.14 bug |
| `plan-mode` (1.3.14 only) | `shortcut` (3), `default-tools` (1) | settings watcher ordering, fixed in 1.4.4 | Bun 1.3.14 bug |

`homedir()` repro (`/tmp/home.mjs`: read `os.homedir()`, set `process.env.HOME`, read again):

```text
node 26.12.0  {"before":"/Users/redd","after":"/tmp/fakehome"}
bun 1.4.4     {"before":"/Users/redd","after":"/Users/redd"}
bun 1.3.14    {"before":"/Users/redd","after":"/Users/redd"}
```

Port effort and order (Vitest-on-Bun path; S < 1 day, M 1-3 days, L > 3 days):

| Order | Unit | Work | Size |
| --- | --- | --- | --- |
| 1 | `subscription-router`, `preset`, `resource-sampler`, `inprocess` (410 tests) | switch `test:bun` to the full suite on Bun; delete nothing else | S |
| 2 | `session-kit`, `plan-mode` (1250) | green on 1.4.4 already; on 1.3.14 fix or gate the 5 version bugs (section 8) | S |
| 3 | `dev-tools` (383) | rewrite the `ChildProcess` fake (19 tests); assertions unchanged | S |
| 4 | `todo`, `subagents` (3665) | inject the home directory instead of mutating `HOME` (26 tests + source seams), one stack-line fix | M |
| 5 | `integration/probes` (15) | `node:test` -> Vitest, both engines | S |
| 6 | `scripts/import_audit.test.ts` (8) | `node:test` -> Vitest on Node ONLY (TypeScript 7 sync API reads Node's `stdout._handle.fd`; fails under Bun) | S |
| 7 | `computer-use` | runner/instrumentation discovery first (PR #162 already marks it pending) | M, separate |

For comparison, the native `bun test` path (section 3) is L for `subagents` alone.

## 3. Bun capability matrix vs needs

Sources: pinned docs `docs/test/*.mdx` at tag `bun-v1.3.14`
([here](https://github.com/oven-sh/bun/tree/bun-v1.3.14/docs/test)), current docs at `bun-v1.4.4`
([here](https://github.com/oven-sh/bun/tree/bun-v1.4.4/docs/test)), the 1.4 notes
([here](https://bun.com/blog/bun-v1.4)) and the probes in the appendix. "M" = measured here.

| Need | `bun test` 1.3.14 | `bun test` 1.4.4 | Vitest on Bun | Vitest on Node |
| --- | --- | --- | --- | --- |
| `vi.fn`/`spyOn`/`mock` factory | yes (M) | yes (M) | yes | yes |
| `vi.mocked`, `waitFor`, `setSystemTime`, `stubEnv`, `hoisted`, `setConfig`, `resetModules` | missing, `TypeError` (M) | missing (M) | yes | yes |
| `vi.importActual` / factory `importOriginal` | missing (M) | missing (M); workaround: import real module before `mock.module` (M) | yes | yes |
| `toHaveBeenCalledExactlyOnceWith`, `describe.runIf` | not checked | missing (M, subagents log) | yes | yes |
| Module-mock isolation per file | shared registry; `--isolate` exists but throws TDZ errors (`Cannot access 't' before initialization`, M: `inprocess` 13 fail, `todo` 73 fail) | `--isolate`/`--parallel` stable (M: subagents 337 -> 84 fail) | per-file pool | per-file pool |
| Sync fake timers incl. `setInterval`, `performance.now` | yes (M) | yes (M) | `@sinonjs/fake-timers` | same |
| `Date` follows `jest.setSystemTime` + advance | no (M) | yes (M; [#33623](https://github.com/oven-sh/bun/pull/33623)) | yes | yes |
| Async timer APIs (`advanceTimersByTimeAsync`, `runAllTimersAsync`) | missing (M) | missing (M) | yes | yes |
| Sync advance vs awaited follow-up timers | runs them (M) | runs them (M); `node:test` `mock.timers.tick` does not (M) | sinon semantics | same |
| Snapshots | yes | yes | yes | yes (unused here) |
| Line + function coverage | yes | yes | Istanbul yes (M) | yes |
| Branch coverage | NO: `BRDA` 0 in LCOV (M) | NO (M; docs list only lines/functions) | Istanbul yes (M) | yes |
| Never-imported files counted | NO (M: absent from text and LCOV) | NO (M) | yes via `coverage.include` (M) | yes (M) |
| Threshold fail-closed | per file (M); lcov-only BYPASS: rc 0 (M) | per file (M); lcov-only rc 1 (M). Docs disagree: `code-coverage.mdx` says lcov-only exits 0, `configuration.mdx` says "any coverage reporter" | Vitest thresholds or accounting script | same |
| Counter stability | JSC; `never.ts` `LF:1` | JSC; same file `LF:2` (M) | Istanbul identical across engines (M) | Istanbul / V8 |
| V8 provider | n/a | n/a | 1.3.14: 0% + 15 unhandled errors (M); 1.4.4: works, 1 branch off Node (M) | yes |
| Watch | yes | yes | yes | yes |
| Parallel / shard | `--parallel`, `--shard` in `--help` (M), undocumented at that tag | documented (`parallel.mdx`), merges coverage + JUnit | pools | pools |
| JUnit reporter | `--reporter=junit` (M, `--help`) | same | yes | yes |
| TS path aliases | tsconfig `paths` honored (M: raw `todo` run resolves `@juicesharp/rpiv-test-utils`); Vitest `resolve.alias` ignored | same | yes | yes |
| Custom runner hooks (plan-mode timeout cap) | no equivalent | no equivalent | yes | yes |
| `vitest bench` | n/a | n/a | FAILS: `bench is not a function` (M) | yes (M) |
| `node:test` files as an interim path | basic `test`/`assert` only; `mock.fn`, `mock.timers` missing; nested `test()` NotImplemented (M) | `mock.fn`/`method`/`timers` work; `mock.module`, `t.assert.snapshot` NotImplemented ([#5090](https://github.com/oven-sh/bun/issues/5090)) (M) | n/a | n/a |
| Engine actually exercised | JSC | JSC | JSC (M: `Bun.version` inside forks pool) | V8 |

`node:test` under `bun test` answer: yes, `bun test` discovers and runs `node:test` files and fails
the run on a failing `node:test` assertion (rc 1, M). It is not a usable interim path: 1.3.14 lacks
the mocks, and even 1.4.4 fails `scripts/import_audit.test.ts` 8/8 and
`integration/probes/transcript-types.test.ts` 1/7 for engine reasons. `dotfiles` on 1.4.4: 269
pass, 9 fail, 7 skip of 285; on 1.3.14 only 223 tests are collected (nested `test()`
NotImplemented). Node: 278 pass, 7 skip.

Native `bun test` with a compatibility preload (scratch shim in the appendix: fills
`mocked`/`waitFor`/`setSystemTime`/`stubEnv`/`hoisted`/`setConfig` and approximates the async
timer APIs; NOT a proposal):

Shim columns use `--parallel=4` except `subscription-router` (serial).

| Package | 1.3.14 raw | 1.3.14 shim | 1.4.4 shim |
| --- | --- | --- | --- |
| `subscription-router` | 163 / 24 fail | 180 / 7 | 185 / 2 |
| `subagents` | 1650 / 390 (baseline) | 2580 / 97 + 91 load errors | 2593 / 84 + 48 load errors; only 2677 of 3285 tests collected |
| `session-kit` | 659 / 52 | 703 / 8 | 705 / 6 |
| `plan-mode` | 507 / 32 | 531 / 8 | 533 / 6 |
| `todo` | 378 / 2 | 314 / 73 (TDZ) | 379 / 8 |

Residual 1.4.4 `subagents` failures still need `importActual` (36), `importOriginal` (10),
`resetModules` (8), `toHaveBeenCalledExactlyOnceWith` (8) and `describe.runIf` (2) rewrites, and
the shim's async-timer approximation is itself untrusted code under every timer test. Even fully
ported, native coverage still has no branches and no unimported files. Rejected (decision D1).

## 4. Python surface

`uv`, `ruff` and `ty` stay for all of it. Per module:

| Module | Size | What it is | TS port would gain | Would lose | Decision |
| --- | --- | --- | --- | --- | --- |
| `scripts/*.py` | 6992 LOC (`package_contracts.py` 4264), 272 tests | release/contract/CI tooling; tests use real disposable git repos and `npm pack` | one language | Pydantic evidence validation (`merge_pr_checks.py`), proven git-fixture tests, ty strictness; no engine coverage gained (it never runs Pi code in-process) | KEEP |
| `integration/harness` + `tests` + `scenarios` | 9313 LOC harness, 322 unit tests, 31 scenario fns | pytest + xdist driving tmux, Pi processes, release fetch; ships `pi-stack-install` via `uvx` (`docs/install.md`) | one language | the shipped `uvx` installer, xdist `loadfile`, tmux tooling, process-boundary tests that must sit OUTSIDE the engine under test | KEEP |
| `benchmarks/comparison` | 4952 LOC src, 3066 LOC tests, 81 tests, pytest-cov 90 (branch) | frozen operator-driven benchmark: Pi 0.85.1 vs Claude Code 2.1.268 / Codex 0.154.0 | one language | historical reproducibility; generated seeds are Python projects graded by `uv`/`ruff`/`ty`/pytest (`fixtures.py:32`, `finalize.py:499-506`), Seatbelt `sandbox-exec` profiles (`finalize.py:426`) | KEEP, frozen |

Why is `benchmarks/comparison` Python:

- No recorded reason. The README and the two in-repo commits (`ace0efa`, `472e8e2`) say nothing
  about language choice
- It was imported as a snapshot of private `pi-harness-benchmark` at `c926ea2` (70 commits,
  `docs/source-provenance.md:17`). That repo is not reachable today (`gh api
  repos/nredd/pi-harness-benchmark`: 404), so its history cannot be checked
- Not pandas or heavy numerics: the only runtime dependency is `pydantic` (`pyproject.toml`);
  imports are stdlib (`subprocess`, `pathlib`, `hashlib`, `statistics`)
- Not Seatbelt either: `sandbox-exec` is a subprocess call from any language
- Inference, NOT recorded: the benchmark's subject fixtures are Python projects, so a
  Python harness that shares `uv`/`ruff`/`ty` with them was the path of least resistance.
  Author preference is equally plausible
- Either way, the migration plan preserves it as historical (`docs/migration-plan.md` section 1:
  "Preserve the benchmark's experimental versions"; out of scope: "historical benchmark reruns").
  A port changes the instrument that produced the retained results, for no engine coverage gain

Python coverage: keep pytest-cov. Emit LCOV (`--cov-report=lcov`) for `scripts/` and
`integration/harness/` so PR #162's pending Python inventories become measured signals in the
same accounting script. Raise `benchmarks/comparison` 90 -> 100 in its own PR (baseline: 94.93%
statements, 85.99% branches).

## 5. Benches

| Bench | Today | Plan |
| --- | --- | --- |
| `packages/subagents` `vitest bench` (4 `*.bench.ts`) | Node; works (M) | KEEP on Node. Under Bun it fails to collect (`bench is not a function`, M). Track a Bun bench run as an issue, not a gate |
| `packages/subagents/test/perf/ab.mjs` | Node script, shells `npx vitest bench` in a temp worktree | KEEP; it is a Vitest driver, not a second tool. Optional `--engine bun` later |
| `packages/subagents/test/perf/*.perf.test.ts` | ordinary Vitest tests | already covered by the test plan, both engines |
| `integration/harness/bench.py` + `integration/scenarios/bench` | pytest, median of 5 vs `baselines/bench.<os>.json`, NOT RUN (no quiet runner) | KEEP Python: it measures Pi processes from outside. Add an explicit engine dimension (Node bundle vs Bun standalone) when the quiet runner exists; baselines per engine, never shared |

No bench becomes a coverage producer. Instrumented runs never refresh baselines.

## 6. Coverage design

Recommended (Vitest + Istanbul, both engines):

- Producer per package: `vitest run --coverage.provider=istanbul` with `coverage.include` set to
  the package's `owned` globs from `coverage/policy.json`. That is the import-all mechanism: Vitest
  instruments matching files that no test imports (M: a fresh `src/zz-never.ts` appears as
  `FNF:1 FNH:0` on Node, Bun 1.3.14 and 1.4.4). No hand-maintained import-all test
- Reporters: `text` + `lcov`, both mandatory (keeps PR #162's producer rule; the Bun lcov-only
  bypass no longer matters because the accounting script, not `coverageThreshold`, enforces)
- Engine-independent counters, measured on `subagents` (Istanbul, `src/**/*.ts`):

  ```text
  node 26.12.0   statements 7198/7852  branches 5254/6139  functions 1265/1331  lines 6221/6722
  bun 1.4.4      statements 7198/7852  branches 5256/6139  functions 1265/1331  lines 6221/6722
  bun 1.3.14     statements 7197/7852  branches 5255/6139  functions 1265/1331  lines 6221/6722
  ```

  Denominators are identical, so the Node and Bun signals are directly comparable and the "JSC and
  V8 counters differ" problem disappears. Hit deltas are the engine-specific paths, which is the
  point of running both. This also answers the reload-accounting question: Istanbul reports the
  same 92.54% lines on both engines, versus V8's documented wrong merge on Node
- Policy plumbing (PR #162, schema 2): `primary` = Istanbul on Node, `bun` = Istanbul on Bun over
  the FULL suite with the SAME `files` inventory as `primary`. No more Bun subset lists
- `enforcement` flip for a package's `bun` signal, `report-only` -> `enforced`, when ALL hold:
  full suite green under Bun on both owned OSes; Bun inventory == primary inventory; complete-source
  receipts recorded; an `enforcement_changes`-style reviewed entry. The accounting algorithm does
  not change (`docs/coverage.md` already says only producer wiring changes)
- Exclusions stay in `coverage/policy.json` only, with reasons; nothing in per-package Vitest
  configs beyond `include`
- Branch coverage: report-only now (PR #162 already reports Istanbul branches). Gate branches only
  after lines/functions reach 100%, as a separate policy flip (decision D4). It is possible ONLY
  because Istanbul works on both engines; Bun-native would make "none" the permanent answer
- Python: pytest-cov LCOV into the same accounting (section 4)
- `node --test` surfaces: disappear from the repo after units 5-6; c8 producers go with them

Fallback if D1 picks native `bun test`: coverage would be lines+functions only forever (no Bun
release offers branches), an import-all test file per package generated from the policy globs (M:
importing `never.ts` makes it appear with `FNH:0`), `text`+`lcov` both mandatory, and a regression
fixture per Bun bump because counters change between versions (M: `LF:1` -> `LF:2`).

## 7. dotfiles

Decision: STAYS on `node --test`, the one documented exception.

- Bun is already installed by chezmoi on every OS (`dot_config/homebrew/Brewfile.tmpl`: `brew
  "oven-sh/bun/bun"`), so "adds Bun" costs nothing on installed machines
- The gate runs BEFORE Homebrew packages: `run_before_00-dotfiles-tests.sh.tmpl` needs a test
  runtime on a fresh bootstrap. Node is there because `nredd/tap/pi-coding-agent` `depends_on
  "node"`; switching to Bun would make the bootstrap gate depend on a second runtime
- It is dependency-free today (stdlib `node:test` + `node:assert`; no `package.json`). Vitest
  would add an npm install to a chezmoi gate
- Measured under Bun 1.4.4: 9 of 285 fail (audit-hook subprocess and apply-gate cases), on 1.3.14
  62 tests are not even collected. Fixing those buys nothing: dotfiles code runs on Node
- Revisit only if the Homebrew formula stops depending on Node

## 8. Risk register and engine crux

Production engine per surface:

| Surface | Engine in production | Evidence |
| --- | --- | --- |
| Owner's machines | Node | `nredd/tap/pi-coding-agent` `1.3.0-nredd.7`: `depends_on "node"` (tap main `16f4462`); local `libexec/bin/pi` shebang `#!/opt/homebrew/opt/node/bin/node`, Node 26.12.0 |
| `@nredd/*` npm consumers | Node | stock Pi 1.3.0 npm package; `contracts` jobs exercise exactly that |
| `resource-sampler` library | Node | `docs/ci.md`: isolated Node consumer |
| Bun standalone | NOT shipped | built from the Gitlink in `stack (..., personal)` only; `v1.3.0-nredd.7` has no standalone assets (`docs/ci.md`); `docs/bun-prerequisite.md`: "the Node/Homebrew tree is the only shipped runtime"; target per `docs/migration-plan.md` section 5 |
| Extensions | the host's engine | loaded in-process by the Pi host, so Node today, JSC under the standalone |

Crux: Bun-only tests would test an engine nobody runs yet and miss Node defects (the
`homedir()` and `ChildProcess` rows prove the engines diverge). Node-only tests miss the
standalone target. Recommendation: dual-engine, same tests, same coverage counters. Node is
`primary` now. When the standalone becomes the shipped runtime, Bun becomes `primary` and Node
stays required because published packages keep serving stock-Pi Node users.

| Risk | Affects | Workaround / gate |
| --- | --- | --- |
| `os.homedir()` ignores runtime `HOME` (1.3.14 and 1.4.4, M) | Bun test hermeticity: source reads the owner's REAL `~/.agents`, `~/.config` | before any full Bun suite runs: launch Bun suites with `HOME` set to a temp dir at spawn, and add a setup assertion that fails if `homedir() !== process.env.HOME`. Then inject home dirs in `subagents`/`todo` |
| Bun `ChildProcess.stdout` is readonly (M) | `dev-tools` test doubles | build fakes from `EventEmitter` + streams, not by mutating `ChildProcess` |
| `process.exit`/`exit` event bug on 1.3.14, passes on 1.4.4 (issue body; not reproduced here) | optional core Bun rows in `forks/pi/packages/codemode/test/worker-lifetime.test.ts` (skipped when `bun` is absent; core CI has no Bun) | gate with the Bun toolchain PR; do not add Bun to core CI on 1.3.14 |
| `NODE_OPTIONS` preloads never load in standalone ([#14](https://github.com/nredd/pi-harness/issues/14)) | 7 auth D/E cases skip | unchanged by this spec; package suites never depend on preloads (Vitest `setupFiles` run inside the pool) |
| Nondeterministic standalone build ([#72](https://github.com/nredd/pi-harness/issues/72)) | `stack` flake, release safety | unchanged; package suites under Bun do not bundle, so they cannot catch or cause it |
| macOS standalone exit flakes ([#100](https://github.com/nredd/pi-harness/issues/100), [#108](https://github.com/nredd/pi-harness/issues/108)) | `stack (macos-14, personal)` | unchanged; existing one-rerun policy. Watch for the same family in Bun package suites (monitor/reaping tests) and file, never retry-until-green |
| Bun 1.3.14 bugs fixed in 1.4.4 (M: `session-kit` 1, `plan-mode` 4; `--isolate` TDZ; `setSystemTime`) | Vitest-on-Bun on the pin | for the 5 tests: either the Bun bump lands first, or they carry a version-scoped `skipIf` naming this table and asserting the version, removed by the bump PR. No blanket skips |
| Vitest under Bun is a Bun compatibility claim ([here](https://bun.com/blog/bun-v1.4), 1.4.0), not a Vitest one; open Bun issues exist ([#21614](https://github.com/oven-sh/bun/issues/21614), [#29711](https://github.com/oven-sh/bun/issues/29711)) | the whole recommendation | pin Vitest and Bun exactly; every bump of either reruns both engines; a regression blocks the bump, not the suite |
| V8 provider under Bun 1.3.14 broken (0%, M) | coverage | use Istanbul (already required for `subagents`) |
| `vitest bench` fails under Bun (M) | benches | keep benches Node-only (section 5) |
| JSC stack/line-number differences (M: `workflow-runtime`) | error-location assertions | assert through source maps both engines agree on, or per-engine expectations with the reason in the test |
| CI time | `owned` cells | measured locally (loaded): full Bun Vitest runs 2-25 s per package, similar to Node. Estimate +2-4 min per `owned` cell including Istanbul; record hosted numbers in PR 2 |

## 9. Phased plan

Acceptance for EVERY phase: green in both `owned` cells (macOS + Linux); no weakened or deleted
assertions; no timeout increases; every gap closed gets a test that fails without the change
(named in the PR); `primary` coverage stays enforced with budgets never raised; `bun` signals
move report-only -> enforced only per section 6; required check names unchanged.

| Phase | Scope | Size | Parallel units |
| --- | --- | --- | --- |
| 0 | this spec, reviewed | S | n/a |
| 1 | hermetic-home guard; full Vitest-on-Bun for the 4 green workspaces; delete their `bun test` subsets | S | 1 owner (touches `Makefile`/policy) |
| 2 | `session-kit`, `plan-mode` (version-scoped 1.3.14 gates), `dev-tools` fakes, `todo` + `subagents` home injection | M | 4 agents, one per package dir; policy edits batched by the coverage owner |
| 3 | Istanbul `primary` everywhere; `bun` signals = full suite, same inventory; flip each `bun` to enforced when it qualifies | M | 1 owner; depends on PR #162 merged |
| 4 | `integration/probes` and `scripts/import_audit.test.ts` to Vitest; drop c8 | S | 1 agent |
| 5 | pytest-cov LCOV for `scripts/` and `integration/harness/`; `benchmarks/comparison` 90 -> 100 | M | 2 agents (disjoint dirs) |
| 6 | Bun 1.4.x toolchain PR with regression fixtures (`homedir`, isolate, timers, lcov threshold, coverage counters), removes phase 2's version gates | S-M | 1 owner, after phase 2 |
| 7 | `computer-use` runner/instrumentation discovery | M | 1 agent, independent |
| 8 | global 100% flip (PR #162's `enforce_target`), branches per D4 | S | 1 owner, last |

First 3 PRs:

1. `Run full Vitest suites on Bun for router, preset, sampler and inprocess`: add a shared
   hermetic-home check (fails when `os.homedir()` and `HOME` disagree, so a Bun run can never read
   the real home), make `test:bun` = `bun --bun vitest run` for those four, delete their `bun test`
   subsets. Gap test: a fixture that mutates `HOME` and must fail the guard under Bun
2. `Inject home directories into subagents and todo config loading`: replace runtime `HOME`
   mutation with explicit seams (pattern exists at `packages/subagents/src/invocation-config.ts:84`);
   then enable their full Bun suites. Gap tests: the 26 currently Bun-failing tests, unchanged
   assertions, green on both engines
3. `Switch coverage producers to Istanbul and declare full-suite Bun signals`: after PR #162 lands;
   every package's `primary` and `bun` read the same `files` inventory; `bun` stays report-only
   until section 6 holds. Gap test: an unimported owned file must appear in BOTH signals' LCOV

## 10. Decisions needed

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | single tool: Vitest on two engines, or native `bun test` port | Vitest on Node + Bun. Native `bun test` is L effort and permanently loses branch coverage and unimported-file coverage |
| D2 | primary engine | Node until the standalone ships; then Bun primary, Node still required |
| D3 | coverage provider | Istanbul everywhere (engine-independent, works on pinned 1.3.14) |
| D4 | branch coverage | report-only now; gate at 100% only after lines/functions hit 100% |
| D5 | Python surface | keep all three modules; add pytest-cov LCOV for `scripts/` and `integration/harness/` |
| D6 | dotfiles | stays `node --test`, documented exception |
| D7 | Bun 1.4.x bump | separate toolchain PR after phase 2; not a blocker for phases 1-3 |
| D8 | `scripts/import_audit.test.ts` | Vitest on Node only, documented (TypeScript 7 sync API needs Node internals) |

## Appendix: reproduce

API counts (from the repo root):

```sh
for d in packages/* integration/inprocess; do for a in mock importActual hoisted advanceTimersByTimeAsync useFakeTimers waitFor setConfig stubEnv resetModules; do
  printf '%s %s %s\n' "$d" "$a" "$(grep -rhoE --include='*.ts' --exclude-dir=node_modules --exclude-dir=dist "\bvi\.$a\b" "$d" | wc -l)"; done; done
grep -rhoE --include='*.ts' --exclude-dir=node_modules --exclude-dir=dist 'importOriginal' packages integration | wc -l
```

Vitest on both engines, per workspace (`todo` adds `--config .vitest.config.ts`):

```sh
node ../../node_modules/.bin/vitest run
/path/to/bun-1.3.14/bun --bun ../../node_modules/.bin/vitest run
bun --bun ../../node_modules/.bin/vitest run   # 1.4.4
```

Coverage counters (`@vitest/coverage-istanbul@5.0.3`, installed `--no-save` for the probe):

```sh
<engine> ../../node_modules/.bin/vitest run --coverage.enabled --coverage.reportOnFailure \
  --coverage.provider=istanbul --coverage.include='src/**/*.ts' --coverage.reporter=text-summary
```

Bun-native coverage probe: `src/half.ts` (one of two functions called), `src/full.ts`,
`src/never.ts` (never imported), `bunfig.toml` `coverageThreshold = { lines = 1.0, functions = 1.0 }`,
then `bun test --coverage --coverage-reporter=lcov` vs `--coverage-reporter=text --coverage-reporter=lcov`:

```text
bun 1.3.14 reporters=text,lcov rc=1  never.ts in lcov: 0  BRDA: 0
bun 1.3.14 reporters=lcov      rc=0  never.ts in lcov: 0  BRDA: 0
bun 1.4.4  reporters=text,lcov rc=1  never.ts in lcov: 0  BRDA: 0
bun 1.4.4  reporters=lcov      rc=1  never.ts in lcov: 0  BRDA: 0
```

Scratch `bun test` preload used for section 3 (not a proposal, not committed elsewhere):

```ts
import { jest, vi } from "bun:test";
const v = vi as unknown as Record<string, unknown>;
const j = jest as unknown as Record<string, (...args: unknown[]) => unknown>;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
v.mocked ??= <T>(x: T): T => x;
v.setSystemTime ??= (d: Date | number) => j.setSystemTime(d);
v.advanceTimersByTimeAsync ??= async (ms: number) => {
  await flush();
  for (let t = 0; t < ms; t++) { j.advanceTimersByTime(1); await flush(); }
};
v.waitFor ??= async (cb: () => unknown, timeout = 1000) => {
  const start = Date.now();
  for (;;) {
    try { return await cb(); } catch (e) { if (Date.now() - start > timeout) throw e; await new Promise((r) => setTimeout(r, 50)); }
  }
};
v.stubEnv ??= (k: string, val: string) => { process.env[k] = val; };
v.hoisted ??= <T>(fn: () => T): T => fn();
v.setConfig ??= () => {};
```
