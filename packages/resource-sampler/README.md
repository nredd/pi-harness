# Resource sampler

Pi-independent, dependency-free ESM library for passive host resource dashboards and snapshots.
`@nredd/pi-resource-sampler` is not a Pi extension. No tools, timers, hooks, output or policy are
registered. Initial implementation only; no consumer migration or npm publication in this PR.

```ts
import { createResourceSampler } from '@nredd/pi-resource-sampler';
const sampler = createResourceSampler();
try {
  const snapshot = await sampler.sample();
  // Caller schedules subsequent samples and renders typed metrics.
} finally {
  await sampler.dispose();
}
```

`sample(signal?)` returns `ResourceSnapshot` v1. Concurrent calls reject. Cancellation rejects and
awaits cleanup; `dispose()` aborts and awaits any active sample, is idempotent, and forbids future
samples. Importing/constructing the library does not collect data. Each instance owns its baseline.

Semantics:

- `cpu`: aggregate host CPU counter delta, 0..100. Core count/model changes, individual counter
  rollback, initial samples, invalid intervals and counters that have not advanced are `warming`,
  never fabricated zero. Uses Node's native `os.cpus()` counters, not load average.
- `processes[].cpu`: Linux user+system counter delta divided by monotonic elapsed milliseconds.
  100 means one logical core, multi-threaded processes can exceed 100. Linux `CLK_TCK` is read
  once with fixed `/usr/bin/getconf CLK_TCK`; no assumed tick rate or RSS page size.
- Linux identity includes the exact `/proc/PID/stat` start tick string. Read stat/status/stat and
  reject identity changes during RSS collection. Missing or inaccessible processes are skipped and
  invalidate their old baselines. New/reused PIDs and counter resets warm rather than showing zero.
- Darwin uses only `/bin/ps -A -c -o pid=,ppid=,lstart=,time=,rss=,comm=` with `LC_ALL=C`.
  Actual macOS observation: `time` prints hundredths (e.g. `185:32.40`), but `lstart` prints only
  seconds (`Sat Oct 3 01:49:05 2026`). That cannot rule out PID reuse within one second, so Darwin
  process interval CPU is explicitly `unavailable`. No decaying `%cpu` is relabelled as an interval.
  RSS/name/parent PID remain useful. No native helper until this limitation justifies one separately.
- `wallTimeMs` labels the start; `monotonicTimeMs` controls intervals. Per-process reads have their own
  monotonic timestamps internally; the scan is not atomic. `durationMs` includes collection.
- `memory.freeBytes` means free, NOT available or pressure. `loadAverage` is load, NOT percent.
  Linux memory PSI preserves native `some`/optional `full`, avg10/60/300 percentages and cumulative
  stall microseconds. Missing/invalid PSI is unavailable. Other platforms explicitly have no PSI.
- Names are bounded basenames with control characters removed; no arguments, environments,
  user names, executable paths or agent attribution are collected. Process names remain untrusted
  display strings; consumers must not execute or interpret them.

Bounds:

- Default scan budget 250ms, 2048 PIDs, 2MiB captured bytes; options allow at most 5s, 16384 PIDs,
  16MiB. Linux proc files read sequentially (concurrency one), at most 8KiB each. Directory iteration
  stops at the budget; Darwin output stops at the PID/output budget and reaps the fixed helper.
- `coverage.complete`, `enumerated`, `sampled`, `skipped`, `bytesRead` and reasons describe partial
  coverage explicitly. `enumerated` is encountered rows, not total processes when partial. Truncation
  is not a host-wide top-process ranking. OS enumeration order may favor the same subset each time.
- Deadline is a monotonic admission/child-kill bound, not a real-time guarantee: event-loop scheduling,
  native `os.cpus()` and in-flight filesystem calls cannot be preempted. Cleanup is always awaited.
  Helpers spawn no descendants, use no shell, stdin ignored, fixed environment, bounded stdout/stderr,
  immediate SIGKILL on abort/deadline/cap, and resolve only on close. No persistent children or workers.
- Unsupported platforms keep native host metrics but report process coverage unavailable.

Local overhead observation (2026-10-22, Darwin arm64, Node 26.12.0, 10 logical CPUs, 16GiB RAM,
load about 6, not a quiet-runner benchmark): ten scans of 557 processes took 17.5-24.9ms each,
about 41.3KB captured, all complete. The Node collector consumed 25.7ms CPU total across ten
scans (2.6ms/sample, excludes helper CPU); a separate fixed `ps` invocation measured 0.02s wall,
0.01s system CPU and 3.0MB peak RSS at `/usr/bin/time -lp` precision. Consumers should poll around
1s, not every render frame. Linux cost is not inferred from macOS; native Linux CI runs the same
real-input gate and reports its snapshot duration/coverage.

Development: `npm run check --workspace @nredd/pi-resource-sampler` (single-worker tests, including
actual host samples and child cleanup); `make check-resource-sampler-contract` builds and exercises
an isolated installed tarball, with no Pi or siblings. Both run on existing macOS/Linux CI jobs.
`dist` contains compiled ESM and declarations; the exact packed payload is contract-pinned. No install
scripts or runtime dependencies. New npm-name ownership bootstrap requires the owner's interactive
2FA/staged publication and trusted-publisher setup; nothing is published automatically by this PR.
