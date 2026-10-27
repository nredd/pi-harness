# Verification engines

Phase 1 of [spec PR #170](https://github.com/nredd/pi-harness/pull/170), tracking
[#160](https://github.com/nredd/pi-harness/issues/160). Vitest is the owned TypeScript tool;
Node stays primary because it ships today. Bun remains required for the standalone target.
No coverage-provider, threshold, required-check-name or runtime-pin change is included here.

| Workspace | Node | Pinned Bun 1.3.14 |
| --- | --- | --- |
| `subscription-router` | Full Vitest + guard | Full Vitest + guard |
| `preset` | Full Vitest + guard | Full Vitest + guard |
| `resource-sampler` | Full Vitest + guard, one worker | Full Vitest + guard, one worker |
| `integration/inprocess` | Full Vitest + guard, spawn-time home | Full Vitest + guard, spawn-time home |
| `session-kit`, `plan-mode`, `dev-tools` | Existing full Vitest | Existing native Bun subsets; full-suite fixes in phase 2 |
| `todo`, `subagents` | Existing full Vitest, guard deferred | Existing native Bun subsets; full suite AND guard deferred to phase 2 |
| `computer-use` | Existing check scripts | Not run |
| `integration/probes`, `scripts/import_audit.test.ts` | Existing `node --test` | Not run; migration in phase 4 (import audit remains Node-only) |

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

Unit tests cover matching, mismatched and missing homes, the four-workspace wiring contract,
and launcher failure/cleanup/argument forwarding. Two subprocess fixtures pin the beforeEach
and afterEach boundaries independently, using canonicalized symlinked temporary homes:
Bun/Vite's bundled config loader otherwise fails through macOS `/var` aliases before reaching
the guard. A subprocess negative control runs the real
`todo.invalidation.test.ts` with todo's existing setup and this guard under Bun: it MUST fail
with `HOMEDIR GUARD`, before test execution. This does not enable or alter todo's normal gate.
`support.test.ts` pins the fixed launch home and independent fixture paths on both engines.

## Phase 2 deferral

Owner: nredd. Expiry: the phase 2 home-injection PR, before full Bun activation for those
packages. The spec's 26 failing assertions are NOT an exhaustive quarantine inventory.
A pinned-Bun guard probe of todo fails 387/387 tests across 28 files: its shared setup mutates
HOME for every test. The same probe passes 387/387 on Node. Excluding the spec's 15 todo
assertion failures would leave 372 guard failures. There is deliberately no skip list and no
informational-only guard. Phase 2 must inject home paths, install this setup in todo/subagents,
and establish full-suite green on both engines. Phase 1 does not touch that worktree or source.

## Coverage handoff

Merge #175 first. Then update [#162](https://github.com/nredd/pi-harness/pull/162)
(`coverage-phase0`) against the merged source; phase 1 deliberately adds no coverage flags.
The four full Bun producers must keep the entry point `node ../../scripts/run-vitest.ts bun`
and pass Vitest options through it, not restore native `bun test`:

```sh
node ../../scripts/run-vitest.ts bun --coverage --coverage.provider=istanbul \
  --coverage.reporter=text --coverage.reporter=lcov --coverage.reportsDirectory=coverage/bun
```

Keep the sampler's `--maxWorkers=1`. Install the Istanbul provider version compatible with the
pinned Vitest. Istanbul works on pinned Bun 1.3.14; do not substitute its broken V8 provider or
Bun-native coverage flags. Both `text` and `lcov` reporters are mandatory. Set explicit
per-signal source inventories and matching instrumentation includes in #162, including
never-imported files where full-source coverage is claimed; test counts alone are not source
coverage. Expected reports, relative to the repository root:

- `packages/subscription-router/coverage/bun/lcov.info`
- `packages/preset/coverage/bun/lcov.info`
- `packages/resource-sampler/coverage/bun/lcov.info`
- `integration/inprocess/coverage/bun/lcov.info`

Keep Bun signals **report-only** with their reasons and per-OS references; keep primary signals
enforced. Changing producers is not an enforcement promotion, permission to merge engine
counters, or permission to raise budgets. #162 must adapt its producer-contract tests and
refresh clean macOS/Linux receipts for these full-suite signals.

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
3. Set `test:bun` to `node ../../scripts/run-vitest.ts bun` (retain the sampler's worker limit).
   Keep it in the package's `check`, hence `make check-ts` and both existing `owned` cells.
4. Extend the wiring regression test and this matrix. Record per-OS counts and the launcher's
   timings in the PR; hosted output is in the existing job summary. No new jobs are needed.
5. Coverage inventory/provider/enforcement changes require the separate coverage policy review;
   a green full Bun suite alone does not flip report-only signals to enforced.
