# Subagents runtime-script coverage

Audience: contributors changing the repository-only subagents build or staleness gate.
This is child #802 of #697, not closure of the umbrella.

`packages/subagents/scripts/build-runtime.mjs` and `check-runtime.mjs` were explicitly
unmeasured `verification_helpers`. They now belong to the independent
`subagents-runtime-tooling` signal. The existing `subagents/primary` and `/bun` inventories
remain `src`-only. Plan-mode's shared builder retains its own `runtime-build-tooling` signal;
this slice does not count that builder twice or change any generated runtime bytes.

Run from `packages/subagents`:

```sh
npm run test:runtime-scripts
node ../../scripts/run-vitest.ts bun --config vitest.runtime-build.config.ts --coverage.enabled=false
```

The Node producer writes `coverage/runtime-build-tooling/{lcov.info,coverage-summary.json}`.
`npm run check` runs it on every owned CI host, before the ordinary source suites. Existing
artifact globs preserve both reports. Accounting requires the report on macOS, Ubuntu and WSL2;
`test_subagents_runtime_scripts_missing_host_report_fails` proves an empty artifact root fails
on each host. Both files have per-file 100% line/function/branch/statement thresholds and
per-OS zero uncovered caps, without exclusions. Before this producer there were no counters,
not zero uncovered counters.

`test/runtime-scripts.test.ts` imports the actual production script modules through Istanbul.
Only their `fileURLToPath(import.meta.url)` package-root discovery is redirected to a disposable
source tree. It does not copy, extract, replace or mock build/verification logic. The real
shared builder, esbuild, source maps, recursive snapshots and filesystem publication execute.
Fixtures cover direct invocation, imports with and without `argv[1]`, a successful byte-stable
build/check, nested lazy chunks, missing/stale/extra files, a missing `dist/`, compiler failure,
package-ownership and symlink refusals, malformed metadata and missing generated output.
The verifier must diagnose without repairing committed bytes, and remove temporary directories
after success and failure. Fixture roots are canonicalized: esbuild resolves symlinked macOS
temporary paths such as `/var` to `/private/var` in its metadata. A symlink-parent fixture
covers this case independently of the host's default temporary directory. No actual core
compilation, provider call or desktop interaction is part of this gate.
