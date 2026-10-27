# macOS /mon accuracy evidence

Owner's arm64 Mac, 16 GiB, 10 logical CPUs. Original screenshots were read directly. No target argv,
environment, localized process titles or Activity Monitor window contents were collected.

## Native process counters

`darwin.ts` lazily loads the runtime's builtin FFI (`node:ffi` on Node >=26.1, `bun:ffi` on Bun,
including the pinned 1.3.14). It calls only three fixed symbols in `/usr/lib/libproc.dylib`:
`proc_pidinfo(PROC_PIDTBSDINFO)`, `proc_pid_rusage(RUSAGE_INFO_V0)` and `mach_timebase_info`.
No new binary, addon, compiler, Python runtime or package dependency is installed or needed.
Node's builtin emits its experimental-FFI warning on first collection; import/construction does not
load FFI. Node 22-25 and unsupported architectures retain ps metadata/RSS with unavailable native
CPU/footprint, not a decaying CPU substitute. Supported native ABIs are Darwin arm64 and x64 LP64.

The fixed SDK layouts are `proc_bsdinfo` (136 bytes) and `rusage_info_v0` (96 bytes). Only numeric
fields and the first NUL-terminated `pbi_comm` (at most 16 bytes) are inspected. `pbi_name`, argv and
environment are never decoded or exported. Names remain untrusted executable names, so `pi` runs
as `node`. Native reads do not require root; denied/exited PIDs retain their ps row and unknown
CPU/footprint. On this Mac 407 of 596 rows had accessible native metrics.

Two rusage reads bracket the metadata read. Start absolute ticks must match and neither read may
have an exit timestamp. The identity includes PID, kernel start absolute ticks, start seconds and
microseconds, PPID and EXACT name bytes. Same-second PID reuse with identical parent/name and
nondecreasing CPU cannot authenticate the previous baseline. Negative cumulative deltas,
parent/name/identity changes and nonpositive/nonfinite or >60-second native intervals warm instead
of inventing CPU. A failed read replaces the strong baseline with an unavailable fallback baseline.
No `ps %cpu` value is used for interval CPU.

MEASURED GOTCHA: rusage CPU counters are Mach ticks, not nanoseconds. The first probe returned
about 2.4% for a busy process when assuming nanoseconds. `mach_timebase_info` on this Mac is 125/3
ns/tick; applying it yields about 99.7%. The captured regression pins this conversion. The kernel
start absolute ticks are identity only; CPU uses cumulative user+system ticks converted with the
native timebase and divided by each observation's monotonic elapsed milliseconds.

Native calls share the existing scan byte/deadline/PID budget: 8 timebase bytes plus 328 bytes per
admitted PID (two 96-byte rusage buffers and one 136-byte metadata buffer), including failed calls.
Admission is checked between calls; each call is synchronous and non-preemptible like `os.cpus()`.
Library handles close in `finally`. No child or persistent worker is introduced for native access.
The existing fixed `ps`, `vm_stat` and `sysctl` helpers retain bounded capture and awaited reaping.

Sources: Apple's SDK `sys/proc_info.h`, `sys/resource.h`, `mach/mach_time.h`; the installed SDK is
`/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk`. These public fixed layouts were checked against
real reads, not guessed from task titles or arguments.

## Concurrent three-process CPU and footprint comparison

Three controlled `/usr/bin/yes` children, all terminated and reaped afterward. Samples overlap the
same real workload; tools do not expose identical atomic per-PID boundaries. Sampler captures were
2026-10-27 17:39:37.819 and 17:39:38.950 UTC; `top -l 2 -s 1` printed its measured interval at
17:39:39 UTC. Selected sanitized output is in `test/fixtures/darwin-cpu-comparison.txt`.

| PID | Sampler interval CPU | ps decaying %cpu | ps cumulative time | top interval CPU | RSS | Native footprint / top MEM |
| --- | --- | --- | --- | --- | --- | --- |
| 83734 | 99.722% | 66.5 -> 99.0% | 0:00.30 -> 0:01.48 | 84.6% | 944 KiB | 1032408 bytes / 1008K |
| 83735 | 99.691% | 66.3 -> 99.3% | 0:00.30 -> 0:01.48 | 84.6% | 944 KiB | 1032408 bytes / 1008K |
| 83737 | 99.766% | 66.3 -> 99.7% | 0:00.30 -> 0:01.48 | 84.7% | 944 KiB | 1032408 bytes / 1008K |

Do not claim bit-for-bit agreement: top's sampling boundaries and collection overhead differ, and
it completed after the sampler's second capture. Its FIRST sample printed 0.0% as a baseline,
not measured idle CPU. The independent ps cumulative counters advanced 1.18 CPU seconds per child;
ps's decaying percentage is labelled as such and is never used by the sampler.

Ten native-enabled scans: 14.96-22.18ms, 596 rows, 241520 charged bytes each; collector CPU
80.7ms total (8.1ms/sample, excludes existing helper CPU). A separate observed full scan was
23.53ms/599 rows/242729 bytes. This fits the default 250ms/2MiB budget. There is no need for
per-PID footprint subprocesses: native `ri_phys_footprint` comes from the same rusage read.
By comparison, measured `top -l 1 -n 1` took 0.32s wall and `footprint --noCategories -p PID`
0.06s for one PID, unsuitable for hundreds of per-PID helpers.

`f` toggles `/mon`'s byte column between `RSS` and labelled `FOOT`; MEM% and `m` sorting remain
RSS-based. Native footprint includes compressed memory; RSS does not. Failed/unsupported PIDs
render `--`, never zero. Process CPU can exceed 100% for multithreaded processes.

Actual workspace sampler + `/mon` mapping/view, executed under pinned Bun 1.3.14, later capture
with three controlled/reaped busy children:

```text
11.2G / 16.0G used (A+W+C)
free 983M swap 3.8G/5.0G
PID        CPU%    FOOT  MEM%  NAME
19614     100.0      1M   0.0  yes
19616     100.0      1M   0.0  yes
19615     100.0      1M   0.0  yes
```

This is real input through the source and renderer, not a fixture or a changed live install.

## Same-second Activity Monitor-style host comparison

No Activity Monitor window was read. Instead, `vm_stat`, `memory_pressure -Q` and fixed `sysctl`
ran between 2026-10-27 17:42:59.850 and 17:42:59.854 UTC (4ms, same wall-clock second). Captured
input is `test/fixtures/darwin-kernel-window.txt`. Derive the standard App/Wired/Compressed/cache
categories from these kernel VM counters; this is not a claim of GUI validation or an atomic
multi-tool read. Apple's category definitions are documented
[here](https://support.apple.com/guide/activity-monitor/view-memory-usage-actmntr1004/mac).

Page size is 16384, not an assumed 4096. Compressed means physical compressor occupancy, NOT the
larger uncompressed equivalent `Pages stored in compressor`.

| Category | Same-capture kernel derivation | Bytes | GiB |
| --- | --- | --- | --- |
| App | (Anonymous 203941 - purgeable 2859) pages | 3294527488 | 3.068 |
| Wired | 171285 pages | 2806333440 | 2.614 |
| Compressed | occupied by compressor 363787 pages | 5960286208 | 5.551 |
| Used (A+W+C) | App + Wired + Compressed | 12061147136 | 11.233 |
| Cached files | (file-backed 217350 + purgeable 2859) pages | 3607904256 | 3.360 |
| Free pages | 58762 pages | 962756608 | 0.897 |
| Swap | sysctl used 3490.88M / allocated 4096.00M | rounded binary MiB | 3.409 / 4.000 |
| memory_pressure -Q | reported 47% free | pressure/reclaimability accounting | NOT free pages or used/total |

The sampler's used metric uses the same App+Wired+Compressed arithmetic. Available is total minus
that estimate, not an allocation guarantee or pressure score. Linux free-page/PSI collection is
unchanged; the sampler did not previously expose MemAvailable. Missing native memory stays
unknown, never a silent total-free fallback under a used label.

Historical screenshots are separate: original `/mon` showed 14.7G/16G non-free (92%); Activity
Monitor showed Used12.81GB (App3.79 + Wired2.88 + Compressed5.53), cache2.93GB, swap3.06GB.
PID37650 RSS515M versus footprint663.8MB, PID11353 RSS163M versus footprint300.2MB. gtop used its
own memory accounting (19%) and swap accounting (77%). Those screenshots are not synchronous with
these probes and must not be presented as today's numbers.

## Owner-gated future release checklist (no publication performed)

- Prepare sampler `0.2.0`: bump its workspace version and root lock in a reviewed PR, retain the
  additive v1 fields and `darwin` ESM/declaration pair in `RESOURCE_SAMPLER_FILES`. Its existing
  `scripts/release_descriptors.py` entry reuses `RESOURCE_SAMPLER_CONTRACT` and the audit/probe;
  no parallel publisher or new release descriptor is needed. Require full package checks, packed
  contract and green macOS/Linux CI, then merge that release preparation separately.
- At the owner's release gate, sign/push `@nredd/pi-resource-sampler@0.2.0` at reviewed merged main.
  Only `publish.yml` publishes: verify -> publish -> release. Verify the SAME tarball's registry
  integrity, signatures, SLSA tag/source/workflow binding, `SHA256SUMS`, `identity.json` and manifest
  per `docs/releases.md`. No local publish, retag, repack or fabricated integrity.
- AFTER publication, bump common `RESOURCE_SAMPLER_VERSION`/`SHARED_LIBRARIES` to `0.2.0` and BOTH
  session-kit and dev-tools exact dependencies. Refresh BOTH nested registry lock entries without
  `npm dedupe`; require real registry URL/integrity and non-symlink installs. Remove the adapter's
  temporary additive-field type shim and update dev-tools' native-CPU docs/contract expectations.
- Run both consumers' registry-resolution/native checks and stock packed contracts plus the sampler
  contract. Prepare/review/publish consumer versions through their existing descriptors, then
  select their proven versions in the stack and require the exact stack CI/promotion gates before
  activation. Publication, stack selection and live installation are separate steps.

This PR does NOT publish, change common pins, tag, promote, activate or merge. Production `/mon`
continues to use published `0.1.1` until the owner's later release/pin work. The draft may become
ready once implementation, measurements, tests and this checklist are complete; publication is
intentionally not a prerequisite for this source PR.

## Regression evidence

- `darwin.test.ts` reconstructs only allowlisted numeric/p_comm fields from this Mac. It rejects
  same-second PID reuse with unchanged parent/name and nondecreasing CPU, in-read reuse, exited
  tasks, parent/name changes, counter rollback, invalid/overlong intervals and malformed layouts.
  It pins the Apple Silicon Mach timebase conversion, invalid UTF-8 handling, failed PID metrics,
  byte/deadline admission and missing builtin FFI.
- Native real self CPU and footprint are required under both Node and pinned Bun in runtime tests;
  existing hostile-child redaction/fragment tests and cancellation/reaping tests remain mandatory.
- Source/component regressions cover independent CPU/footprint states, failed PIDs as unknown,
  labelled footprint toggling at 40/60/80/120 columns, free/swap/basis labels and all help at 40x12.
- The packed probe requires native self CPU/footprint on supported Node, plus host usage/swap.
  The exact payload adds only `dist/darwin.js` and `dist/darwin.d.ts` (13 paths total).

There is no `docs/coverage.md` on base main. The one new production file `src/darwin.ts` is inventoried
above with its parser, native failure/budget, runtime and packed-contract coverage.

Executed local gates: sampler Biome/tsc/build, complete Vitest 33 and pinned-Bun runtime 7;
session-kit Biome/tsc, complete Vitest 718 and pinned-Bun scenarios 74; packed sampler contract
(exact 13-path tarball, native CPU/footprint required); complete `make check-scripts`, Ruff/ty,
693 pytest and import-audit helper. Both Bun suites ran 1.3.14, not the host's newer default.
Native Linux and final-HEAD remote CI remain CI evidence, not local execution claims.

Mutation/revert proof, retained tests, restored source afterward:

| Closed gap | Deliberately remove | Failing result |
| --- | --- | --- |
| Same-second PID reuse | Strong start ticks/usec from native identity | expected warming, got available |
| Accurate CPU units | Mach timebase conversion | expected 1646.833625ms, got 39.524007ms |
| Native footprint | Returned footprint field | expected 1032408 bytes, got undefined |
| Labelled footprint toggle | FOOT column label | all four width cases fail |
| Used/free/swap/help | Original PR production-source reversal | four parser/mapping/render/help regressions fail |

After restoration: complete sampler 33 and targeted adapter/render 50 pass. Executed gate logs
and mutation outputs are linked by absolute local path in the PR review receipt; remote CI links
will provide portable evidence for the final pushed SHA.
