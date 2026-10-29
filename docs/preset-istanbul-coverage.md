# Preset Istanbul coverage receipt

Measured on macOS with Node 26.12.0, Bun 1.4.4, Vitest 5.0.3 and an ephemeral
`@vitest/coverage-istanbul@5.0.3`. Base: `02e3159b7676479ff5ac8a846e4d8ff67089412f`.
No production source, dependency manifests, lockfiles, coverage policy or runner config changed.

V8 is not a trustworthy before value for this suite: native discovery loads the same source
URLs through Pi/Jiti while direct behavior tests use Vitest's transform. V8 merges incompatible
generated offsets before remapping. Istanbul instruments the direct module paths; the unchanged
native discovery tests remain behavioral evidence, not a claim of instrumented Jiti execution.

## Before and after

The same source inventory and Istanbul command were used for both runs. Counts are covered/total.

| Source | Before lines | After lines | Before functions | After functions |
| --- | --- | --- | --- | --- |
| `extensions/expanded-footer.ts` | 156/163 | 163/163 | 30/35 | 35/35 |
| `lib/footer-cache.ts` | 41/41 | 41/41 | 8/8 | 8/8 |
| `lib/footer-quota.ts` | 105/106 | 106/106 | 25/30 | 30/30 |
| Total | 302/310 | 310/310 | 63/73 | 73/73 |

Before: 127 tests. After: 131 tests, all nine files, on both Node and Bun.
After Istanbul statements: 366/369; branches: 285/299. Neither is claimed as 100%.

Actual baseline uncovered locations (`coverage-final.json` function declaration positions):

- `expanded-footer.ts`: lines `82,84,85,86,89,90,91`; functions `82:1` (default now),
  `83:1` (timeout), `86:11` (timeout cancellation), `88:1` (interval), `91:11` (interval cancellation).
- `footer-cache.ts`: no uncovered lines or functions.
- `footer-quota.ts`: line `272` (synchronous emit failure cleanup); functions `209:19`,
  `210:21`, `211:19`, `212:21` (default timer dependencies), `262:18` (initial unsubscribe).

Tests import the actual extension/helper modules, without aliases, copied logic or module mocks.
Default timer adapters run against Vitest's injected fake clock; no sleeps or HOME mutation.
The renderer checks deferred RPC dispatch, quota freshness/expiry, recurring requests and cancellation.
The standalone poller checks default UUIDs, freshness, expiry, listener removal and cancellation.
The emit-failure test verifies retained stale figures, cleanup and successful subsequent recovery.

The initial unsubscribe is reachable through the declared `EventBus` interface if `on` invokes
its handler synchronously (e.g. a replaying bus). The replay test proves the snapshot settles once
and a later deadline cannot stale it. This is an interface-boundary test, NOT a claim that Pi's
current event bus replays on subscription. In that case the returned unsubscribe is not called
by the current implementation (`offCalls === 0`); the test preserves and exposes that limitation,
rather than claiming replaying-bus listener cleanup. No callbacks were deleted to change totals.

## Commands

From a fresh worktree with `npm ci --ignore-scripts`, install the provider outside the checkout:

```sh
npm install --prefix /tmp/preset-diag-tools --no-save --ignore-scripts \
  @vitest/coverage-istanbul@5.0.3
ln -s /tmp/preset-diag-tools/node_modules/@vitest/coverage-istanbul \
  node_modules/@vitest/coverage-istanbul
cd packages/preset
../../node_modules/.bin/vitest run --maxWorkers=1 \
  --coverage --coverage.provider=istanbul \
  --coverage.reporter=lcov --coverage.reporter=text --coverage.reporter=json \
  --coverage.reportsDirectory=/tmp/preset-ist-before \
  --coverage.include=extensions/expanded-footer.ts \
  --coverage.include=lib/footer-cache.ts \
  --coverage.include=lib/footer-quota.ts
# Repeat after changes with --coverage.reportsDirectory=/tmp/preset-ist-after.
node ../../scripts/run-vitest.ts bun --maxWorkers=1
npm run lint
npm run typecheck
```

The existing matching provider in `/tmp/preset-diag-tools` was reused, with its version verified;
the symlink is inside this worktree's ignored, separately installed `node_modules`, not another
worktree's dependencies. Both coverage runs and all listed gates exited 0.
No repository-wide gate or live-install activation is claimed.

Host snapshots before suites showed 10 logical CPUs, load 2.49-4.04, 16-43% sampled utilization,
and 59-61% memory-pressure free. One worker was used throughout. This agent had no nested agents
running during suites. Cross-session agent enumeration was not exposed by this session's tools;
OS processes were not used to infer agent identity. The two review agents run after the gates.

## Mutation checks

Each temporary production mutation was restored before the full final gates; production diff is empty.
Commands ran from `packages/preset`, using `../../node_modules/.bin/vitest run --maxWorkers=1`:

| Mutation | Remaining command arguments | Result |
| --- | --- | --- |
| Replace default `clearInterval(timer)` with `void timer` | `test/footer-render.test.ts -t 'default clock'` | Exit 1: expected zero timers after dispose, received one |
| Remove `settle(token, undefined)` from emit catch | `test/footer-quota.test.mjs -t 'synchronous emit failure'` | Exit 1: expected zero reply handlers, received one |
| Make the initial `off` closure throw | `test/footer-quota.test.mjs -t 'replays during subscription'` | Exit 1: `mutation: initial unsubscribe invoked` |

Logs and machine-readable reports from this execution are in `/tmp/preset-ist-{before,after}*`
and `/tmp/preset-ist-mutation-{interval,emit,replay}.log`; those temporary files are not shipped.
