# Resource sampler

Pi-independent, dependency-free ESM library for passive host resource dashboards and snapshots.
`@nredd/pi-resource-sampler` is not a Pi extension. No tools, timers, hooks, output or policy are
registered. Runs on Node >=22.14 and Bun.

Sampler `0.2.0` adds native Darwin interval CPU/footprint and host used/swap metrics. Its
consumer pins are exact registry dependencies, never workspace links.

Upgrade from `0.1.0`, which is unsafe: on Darwin it reported `ps -c -o comm`, the basename of argv[0],
so a launcher-chosen argv[0] or Node `process.title` (e.g. `npm exec <package> mcp`) leaked into
`processes[].name`. On Bun, host `cpu` read lazily populated `os.cpus()` objects, so the second sample
was `warming` and the third could be a fictional 0 or 100. `0.1.1` keeps the same TypeScript interface.

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
- `processes[].cpu`: cumulative user+system counter delta divided by monotonic elapsed milliseconds.
  100 means one logical core, multi-threaded processes can exceed 100. Linux `CLK_TCK` is read
  once with fixed `/usr/bin/getconf CLK_TCK`; no assumed tick rate or RSS page size.
- Linux identity includes the exact `/proc/PID/stat` start tick string. Read stat/exe/status/stat and
  reject identity changes during RSS collection. Missing or inaccessible processes are skipped and
  invalidate their old baselines. New/reused PIDs and counter resets warm rather than showing zero.
- `cpu` copies every `os.cpus()` counter when sampled. Bun returns lazy placeholders that read native
  counters on first property access; an unread stored baseline would describe a later instant.
- Darwin enumerates metadata with fixed `/bin/ps -A -o pid=,ppid=,lstart=,time=,rss=,ucomm=`
  and `LC_ALL=C`. Builtin FFI (Node >=26.1, Bun; toolchain pin in root `.bun-version`) then reads fixed symbols
  `proc_pidinfo`, `proc_pid_rusage` and `mach_timebase_info` from `/usr/lib/libproc.dylib`, without
  root, a compiler, addon or new binary/package dependency. Import/construction does not load FFI.
  Node emits its builtin experimental-FFI warning on first use; Bun does not. Node 22-25 keeps
  metadata/RSS but explicitly unavailable CPU/footprint. ABI access is restricted to Darwin arm64/x64.
- Native Darwin identity includes PID, kernel process-start absolute ticks, microsecond start time,
  PPID and exact `p_comm` bytes. Rusage reads bracket metadata; changed start/exit state or counter
  rollback rejects the native read. Same-second PID reuse cannot authenticate an old baseline even
  with identical parent/name and nondecreasing CPU. Each observation has its own monotonic timestamp.
  Identity/parent/name changes, negative deltas, nonpositive/nonfinite intervals and native intervals
  over 60s warm instead of fabricating CPU. Native CPU counters are Mach ticks converted using the
  kernel timebase (125/3 ns per tick on this Apple Silicon Mac), NOT assumed nanoseconds.
- `processes[].footprint` is an optional Darwin metric from `ri_phys_footprint`, including compressed
  memory. Native `rssBytes` comes from `ri_resident_size`. Inaccessible/exited/reused PIDs or exhausted
  native budgets retain the enumerated metadata/RSS row with unavailable CPU/footprint; unsupported
  runtimes do the same. No failed footprint is encoded as zero. `ps` fallback identity has only
  whole-second precision, so it NEVER supplies interval CPU. No decaying `%cpu` is relabelled.
- `wallTimeMs` labels the start; `monotonicTimeMs` controls intervals. Per-process reads have their own
  monotonic timestamps internally; the scan is not atomic. `durationMs` includes collection.
- `memory.freeBytes` means free, NOT available or pressure. Darwin adds optional v1 `memory.usage`
  and `memory.swap` metrics. `usage.value.usedBytes` estimates resident App + Wired + Compressed RAM:
  `(Anonymous pages - Pages purgeable + Pages wired down + Pages occupied by compressor) * page size`
  from fixed `/usr/bin/vm_stat` output. The page size comes from its header, never an assumed 4KiB.
  `availableBytes` is total minus that estimate (reclaimable cache included), NOT a pressure score or
  an allocation guarantee. Compressor occupancy is physical RAM, not `Pages stored in compressor`.
  Swap used/allocated bytes come from fixed `/usr/sbin/sysctl vm.swapusage` (binary MiB).
  Invalid/missing/over-budget counters are `unavailable`, never zero or a silent total-free fallback.
  Older producers and non-Darwin platforms omit these additive fields. Linux's existing free-page/PSI
  semantics are unchanged; this library did not expose Linux MemAvailable.
  Both helpers share the existing scan budget, fixed environment, output bound and awaited reaping.
  `loadAverage` is load, NOT percent.
  Linux memory PSI preserves native `some`/optional `full`, avg10/60/300 percentages and cumulative
  stall microseconds. Missing/invalid PSI is unavailable. Other platforms explicitly have no PSI.
- `processes[].name` is an executable basename from kernel metadata. It excludes argv, environment,
  process title and Linux comm, but it is still untrusted metadata that the process or its launcher can
  choose (see the last item). `""` means unavailable, not a process called nothing:
  - Darwin: native `proc_bsdinfo.pbi_comm`, or `ps ucomm` from kinfo `p_comm`. XNU writes it at exec, from the
    looked-up executable file name, truncated to 16 bytes (`Google Chrome He`). `ps -c -o comm` is
    argv[0] and is NOT used.
  - Linux: basename of `readlink /proc/PID/exe` (` (deleted)` marker removed), read between the two
    identity-checked stat reads. The kernel gates that link by ptrace read access, so other users'
    processes are usually `""` without privileges. `/proc/PID/stat` comm is NOT used:
    `prctl(PR_SET_NAME)`, `/proc/self/comm` and Node's `process.title` rewrite it. Kernel threads
    have no `VmRSS`, so they are skipped (`process-unreadable-or-changed`) and never named.
  - Whoever names, links or copies the executable file chooses the name. On Linux a process can also
    exec a `memfd_create` file it named itself (`memfd:<name>`), and a privileged one can replace its
    exe link with `prctl(PR_SET_MM_EXE_FILE)`. Names are bounded to 128 code points with control
    characters replaced, no user names, paths or agent attribution are collected, and consumers must
    treat them as untrusted display text, never execute or interpret them.

Bounds:

- Default scan budget 250ms, 2048 PIDs, 2MiB captured bytes; options allow at most 5s, 16384 PIDs,
  16MiB. Linux proc files read sequentially (concurrency one), at most 8KiB each. Directory iteration
  stops at the budget; Darwin output stops at the PID/output budget and reaps the fixed helper. Native reads charge
  8 bytes for the timebase and 328 bytes per admitted PID (two 96-byte rusage buffers and one 136-byte
  metadata buffer), including failed calls, to that SAME byte budget. Only `pbi_comm` and numeric
  fields are inspected; `pbi_name`, arguments and environment are never decoded or exported. Native
  syscalls are synchronous/non-preemptible like `os.cpus()`; admission is checked between reads.
- `/proc/PID/exe` is a `readlink`, which Node and Bun cannot cap: each call copies up to PATH_MAX
  (4096) bytes into a fixed runtime buffer before the length is known. That fixed per-call syscall
  copy can exceed the remaining budget; the logical budget cannot. A target longer than the remainder
  is charged the remainder, so `bytesRead <= maxBytes`, and the budget is then exhausted: that
  process's `status` read is refused, so the whole process is skipped
  (`process-unreadable-or-changed`, `byte-limit`), not kept with an empty name, and the scan stops.
  A target filling the 4096-byte buffer may be truncated: Node returns it silently, the name is
  dropped (`""`, `file-byte-limit`) and the process is kept. Bun's readlink source refuses such a
  target with `ENAMETOOLONG`, which would take the unreadable-link path (`""`, no reason); that Bun
  path was read in source only, never executed here.
- `coverage.complete`, `enumerated`, `sampled`, `skipped`, `bytesRead` and reasons describe partial
  coverage explicitly. `enumerated` is encountered rows, not total processes when partial. Truncation
  is not a host-wide top-process ranking. OS enumeration order may favor the same subset each time.
- Deadline is a monotonic admission/child-kill bound, not a real-time guarantee: event-loop scheduling,
  native `os.cpus()` and in-flight filesystem calls cannot be preempted. Cleanup is always awaited.
  Helpers spawn no descendants, use no shell, stdin ignored, fixed environment, bounded stdout/stderr,
  immediate SIGKILL on abort/deadline/cap, and resolve only on close. No persistent children or workers.
- Unsupported platforms keep native host metrics but report process coverage unavailable.

macOS measurement/definition comparison, native ABI evidence and future publication checklist:
[here](../../docs/mon-accuracy.md). Process `rssBytes` still excludes compressed pages; it is not
Activity Monitor's physical footprint; use the separate `footprint` metric for that comparison.
Names remain executable names, so Pi commonly appears as `node`.

Local overhead observation (2026-10-22, Darwin arm64, Node 26.12.0, 10 logical CPUs, 16GiB RAM,
load about 6, not a quiet-runner benchmark): ten scans of 557 processes took 17.5-24.9ms each,
about 41.3KB captured, all complete. The Node collector consumed 25.7ms CPU total across ten
scans (2.6ms/sample, excludes helper CPU); a separate fixed `ps` invocation measured 0.02s wall,
0.01s system CPU and 3.0MB peak RSS at `/usr/bin/time -lp` precision. Consumers should poll around
1s, not every render frame. Linux cost is not inferred from macOS; native Linux CI runs the same
real-input gate and reports its snapshot duration/coverage.

Development: `npm run check --workspace @nredd/pi-resource-sampler` (single-worker tests, including
actual host samples and child cleanup). The full suite runs through Vitest on Node and pinned Bun.
Native failure tests inject fixed bindings through the same lazy loader seam used by production,
not a Node-shaped global builtin mock; they do not require the runtime's real FFI to exist.
`test/runtime.test.ts` runs under both engines: it starts a child whose argv[0], argv, environment, process title and (Linux) comm hold a
random secret, proves the 0.1.0 source exposes it, then requires the child in the snapshot and no
12-character fragment of the secret, plus three real CPU samples. Everything after spawn, readiness
included, is followed by SIGTERM, then SIGKILL, with a bounded wait for the runtime's exit status
of that exact child (never a PID probe); a cleanup failure is reported alongside the original error
(`AggregateError`), never instead of it. Regressions make readiness and the negative control fail
and require the child reaped, including a child that ignores SIGTERM and needs SIGKILL, and inject a
cleanup failure to require both errors. This cleanup is in-process only: if the test worker itself
is SIGKILLed, no JavaScript runs and the child outlives it. The packed contract probe below instead
runs in its own process group, which the gate kills on its Python timeout or `KeyboardInterrupt`
while the leader is unreaped; an already reaped leader, or an unhandled SIGTERM/SIGHUP or SIGKILL of
the gate, skips that cleanup and may leave members behind. The privacy
check samples with the library maxima (5s, 16384 PIDs, 16MiB) and never accepts a missing child as
a pass: on a host whose processes exceed those bounds, or whose enumeration reaches the child only
after them, it fails with the snapshot's coverage in the error. On Linux each process costs two
`stat` reads, the `/proc/PID/exe` target bytes and `status`, so the byte bound can bind before the
PID bound. `make check-resource-sampler-contract` builds and exercises an isolated installed
tarball, with no Pi or siblings. Both run on existing macOS/Linux CI jobs.
`dist` contains compiled ESM and declarations; the exact packed payload is contract-pinned. No install
scripts or runtime dependencies. Releases publish through `publish.yml` with npm provenance; see
[releases](../../docs/releases.md).
