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
Node. Istanbul consolidation and coverage-policy changes belong to phase 3.

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
and afterEach boundaries independently. A subprocess negative control runs the real
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
