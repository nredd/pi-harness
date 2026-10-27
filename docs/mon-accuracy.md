# macOS /mon measurement evidence

2026-10-27, owner's arm64 Mac, 16 GiB, 10 logical CPUs. No argv or environment collected.
The original three screenshots were read directly. They are historical observations, NOT synchronous
with this investigation. A same-moment Activity Monitor comparison was not captured; do not present
its historical numbers as validation of today's host-memory estimate.

## Definitions and measurements

Native commands below were bounded to one/two observations. Selected names are kernel executable
names only; parser inputs live in `packages/resource-sampler/test/fixtures/`.

| Source | Observation | Meaning |
| --- | --- | --- |
| Original `/mon` screenshot, 10:07:42 | 14.7G / 16.0G non-free, 92%; PID 37650 515M, 11353 163M, 10535 204M | total minus free pages; process RSS |
| Original Activity Monitor screenshot | Used 12.81 GB = App 3.79 + Wired 2.88 + Compressed 5.53; cache 2.93; swap 3.06 | physical used RAM, excluding reclaimable files |
| Original Activity Monitor process rows | PID 37650 663.8 MB, 11353 300.2 MB, 10535 228.6 MB | physical footprint, including compressed/private allocations |
| Original gtop screenshot | Memory 19%, swap 77%; node 82.7%, scenarios 134.6% | gtop's own memory definitions and process CPU source, not comparable to free-page subtraction |
| `vm_stat`, 17:15:55 UTC | anonymous 241117, purgeable 2046, wired 180763, compressor occupancy 393195; page size 16384 | proposed used estimate 13320667136 bytes (12.41 GiB); free 29437 pages (460 MiB) |
| `sysctl`, same command window | RAM 17179869184 bytes; swap total 4096.00M, used 3079.44M, free 1016.56M | binary MiB, allocated swap, not RAM |
| `memory_pressure -Q`, same window | 43% free | reclaimability/pressure accounting, NOT free pages or Activity Monitor used RAM |
| `ps`, 17:15:55-56 UTC | PID 37650 RSS 682032 -> 686576 KiB, `%cpu` 17.5 -> 15.6; 11353 RSS 230736 KiB | RSS; decaying CPU, NOT an interval counter |
| `top`, second sample 17:15:57 UTC | PID 37650 MEM 671M, CMPRS 104M, CPU 37.0%; 11353 MEM 357M, CMPRS 125M, CPU 2.0% | MEM is physical footprint; CMPRS is compressed contribution, NOT total memory; RPRVT N/A |
| `top`, 17:16:55 UTC, selected PID | PID 37650 MEM 734M, CMPRS 159M | later observation, not equal-time comparison |
| `footprint --noCategories -p 37650`, later | phys_footprint 719 MB; peak 1460 MB | no root needed for this own-user process; not RSS |

App resident pages are estimated as anonymous minus purgeable, then wired and physical compressor
occupancy are added. Do not add `Pages stored in compressor`: that is the logical uncompressed
page count. Do not infer pressure from used/total. Native reads are non-atomic, as is the existing
process scan. This is a labelled VM-counter estimate, not an assertion of bit-for-bit agreement
with Activity Monitor's private implementation.

## Bounds and native access

`/usr/bin/time -lp` observed `vm_stat` and fixed swap `sysctl` each at 0.00s wall at its precision,
about 1 MiB RSS each. A single `top -l 1 -n 1 -stats pid,cpu,mem` took 0.32s wall, 0.30s CPU,
5.6 MiB RSS: it already exceeds the default 250ms scan budget before per-process reads.
`footprint --noCategories -p 37650` took 0.06s wall, 0.03s CPU, 10.6 MiB RSS for ONE process.
Hundreds of footprint children do not fit the default budget. Keep RSS and explain its limits.

Read-only ctypes availability probe: `proc_pidinfo` flavor 3 returned 136 bytes for an own-user
process without root; `proc_pid_rusage` exists in `/usr/lib/libproc.dylib`. The SDK's
`sys/proc_info.h` exposes microsecond start time in `proc_bsdinfo`, and native rusage exposes
cumulative CPU/footprint. These APIs could support a stronger identity. No Python, Swift, addon,
compiled helper, native library dependency or native ABI binding is shipped by this change.

Node 26.12.0 on this Mac DOES expose experimental `node:ffi` (since 26.1). Loading it emits a
process-global ExperimentalWarning. Bun 1.4.4 does not implement `node:ffi`; the library's Node
minimum remains 22.14. A stable, portable binding is not already part of the sampler contract.
A version-gated, bounded native helper could be designed separately; it has not been implemented
or verified here. Native interval CPU remains an OPEN gap, not a claim of technical impossibility.

The existing fixed `ps` format was measured again: `lstart` contains whole seconds, `time`
hundredths; `etime` contains whole seconds too. PID+PPID+ucomm plus nondecreasing CPU is not proof:
a reused PID in the same start second can have the same parent/executable and MORE cumulative CPU
than the former short-lived process. Sequential PID allocation makes that unlikely, not impossible.
Do not relabel `ps %cpu` as interval CPU or weaken the redaction/name rule to obtain titles.

## Release and regression status

The sampler adds optional v1 native host-memory and swap metrics; Linux collection stays unchanged.
The session-kit adapter accepts them and distinguishes unavailable from old producers. Both plugin
consumers intentionally still resolve published `0.1.1`; the production dashboard therefore shows
`total-free`, not the new used estimate, until a subsequent common pin/registry-lock bump after
publishing the sampler. This change alone does NOT close the full release requirement.

Regression seams:

- `sampler.test.ts`: captured Apple Silicon `vm_stat`, exact used/available arithmetic, physical
  versus logical compression, native swap, invalid/missing/duplicate/over-total counters, budget
  admission, real host fields, and unchanged non-Darwin fields.
- `source.test.ts`: additive fields override total-free; failed native usage/swap render unknown;
  legacy producers retain an explicit total-free basis.
- `component.test.ts`: free/swap and basis labels, narrow compact label, all four help explanations
  reachable at 40x12; existing names/width/selection/lifecycle cases remain.
- Packed contract probe: require native usage/swap on Darwin and unchanged Linux omission.
  `test_library_probe_rejects_missing_native_memory` runs that assertion against missing-field
  producers and requires the privacy marker child to be reaped.

A later single-snapshot live mapping (Bun, same raw snapshot mapped with and without additive
fields) rendered:

```text
Registry-compatible: 15.3G / 16.0G total-free
                     free 676M swap --/--
Workspace sampler:   11.9G / 16.0G used (A+W+C)
                     free 676M swap 3.4G/4.0G
```

That scan took 49.7ms, 690/690 rows, 53074 captured bytes, complete. This exercises the workspace
sampler and actual view mapping, NOT a changed registry dependency or a live installed Pi session.

Executed gates: sampler Biome/tsc/build, Vitest 24 and Bun 7; session-kit Biome/tsc/full Vitest 713
and Bun scenarios 74; packed sampler contract; complete `make check-scripts` (693 pytest plus
format/lint/types and import-audit helper). Bun here was 1.4.4, not the CI-pinned runtime. Linux
parser/omission cases ran locally; native Linux collection and the complete CI matrix await PR CI.
Full unrelated-workspace `make check-ts`, integration and benchmark gates were NOT run locally.

Revert proof (tests retained, only production source diff reversed, then restored):

| Gap | Regression | With source reverted |
| --- | --- | --- |
| Native host memory | `parses captured Apple Silicon pages` | fails: native parser absent |
| Correct mapping, no fallback on failure | `prefers additive native memory` | fails: 15 GiB versus expected 12 GiB |
| Measurement/free/swap labels | `labels the measurement basis` | fails: used label missing |
| All four help explanations | `scrolls all metric explanations at 40x12` | fails: total-free explanation missing |

After restoration: sampler 24 and targeted adapter/render 45 tests pass. These tests do not claim
to close interval CPU or to activate the unpublished metrics in the pinned consumer.

No `docs/coverage.md` exists at the base commit. No new production source files were added.
