Audience: maintainers chasing Pi startup latency (#577). Historical measurements below are one Mac,
one profile and the OLD echo-based readiness method. They are not command-dispatch acceptance evidence.

Readiness correction (#782):
- `input_ready_s` now requires the real Pi command dispatcher to invoke an ephemeral local extension
  handler with a per-launch random nonce and write its exact acknowledgement. Cooked tty/editor echo
  alone cannot satisfy readiness. The sampler waits for both footer and extension registration before
  submitting only `/harness-startup-ready-<nonce> <nonce>`, never a model prompt.
- This measures an observed dispatch upper bound, including tmux start/capture/send/poll overhead and the
  probe extension's import/factory. It does not certify all `session_start` handlers have completed or
  separate resource/model phases. Do not subtract it from unrelated totals to invent phase attribution.
- New reports and `--record` baselines declare `readiness_method: command-dispatch-v1`; recorded baselines
  contain `medians`. `--baseline` rejects legacy echo baselines. Existing files remain historical,
  unchanged; record any future quiet-runner baseline in a NEW file, never overwrite the history below.
- Unit tests cover cooked echo, early footer, missing/malformed acknowledgements, nonce rejection,
  timeout and process/scratch teardown. The native faux CLI scenario dispatches the real handler in a
  synthetic HOME, with a network-denying preload and zero provider requests. The preload uses shared
  `runtime_hooks` for both Node and compiled Bun, preserving supplied runtime flags. A per-run loaded
  acknowledgement is required before absence of network/provider logs can count as evidence; missing,
  malformed or failed preloads fail closed. Node and a small actual compiled Bun fixture exercise guard
  admission separately from the native faux dispatch. This is correctness coverage, not a performance
  gate. No latency budgets or thresholds changed.
- #577 remains OPEN: phase attribution, exact profile-equivalent identities and five first/naturally-warm
  samples per fresh/resumed cell still need controlled measurement. No new latency regression is claimed.

Bounded phase capture (#577, not latency acceptance):
- New captures accept at most 64 KiB / 1024 lines, reject duplicate accepted phase keys and durations
  over one day, and close timing sections at separators. The sampler reads at most 64 KiB + one
  character from its private stderr file; parsing also checks the UTF-8 byte bound. This bounds
  report parsing, NOT the producer's total temporary disk output before the existing timeout.
- Only known `main` labels and `extensions:TOTAL` are included by default. Arbitrary labels, unknown
  sections and extension paths are omitted. Missing phases remain absent, never zero or inferred.
- For an explicit synthetic fixture, repeat `--extension-label fixture-faux=/exact/fixture/faux.ts`.
  Exact paths map to unique bounded `fixture-*` aliases for `module import` / `factory` counters.
  No path, package name or private label is copied from stderr into a new phase report. This only
  sanitizes timing keys; argv, host metadata and other report fields still require publication review.
- The parser does NOT add instrumentation to core. Existing `PI_TIMING` counters use `Date.now()`;
  they are wall-clock deltas, not a monotonic critical-path trace. Resource discovery, registration /
  offline refresh and completion of ALL `session_start` handlers remain unmeasured where the selected
  binary lacks explicit boundaries. Source labels alone are not installed-binary evidence.
- Correctness tests use synthetic stderr and fake panes, including an oversized real private stderr
  file, exact extension alias matching, unknown labels, duplicates, byte/line limits and cleanup.
  These tests are not quiet-runner or full-profile startup measurements.
- The controlled identity and 40-launch plan is [here](startup-measurement-plan.md). No new baseline,
  latency threshold, deadline increase, provider call or optimization is part of this change.

Measure:
- `cd integration && uv run python -m harness.startup --runs 10 --gap 0.5 --variant wrapper=pi --variant direct=<core>/bin/pi`
- Drives the selected installed `pi` in a private tmux pane in an empty scratch dir. Loads a temporary
  extension and submits its nonce command only. Use explicit synthetic HOME/profile environment for
  unattended runs: loading the owner's profile can itself have startup side effects, independent of the probe
- `first_paint_s`: first non-blank frame. `frame_s`: footer drawn (`--frame-pattern`, default `\bctx\b`
  is the owner's preset footer). `input_ready_s`: nonce acknowledgement from the command handler
- Phases come from bounded `PI_TIMING=1` stderr (`main:*`, and explicitly aliased extension `module import` / `factory`). Inherited `PI_*` is scrubbed, `--env KEY=VALUE` adds back e.g. `PI_CODING_AGENT_DIR` for an explicit synthetic profile
- Variants alternate order each round. `--gap N` idles N seconds first: 0.5 is naturally warm, 25 is an idle gap. Neither is an OS-cold cache, none was claimed
- `--record NEW_FILE` stores versioned medians; `--baseline FILE` exits 1 for an incompatible method
  or when a median is >20% over a compatible baseline (same threshold as `harness/bench.py`). Baselines
  are per machine and NOT a CI gate: runners are not quiet. `integration/baselines/startup.darwin.json`
  is historical echo-method evidence and is intentionally rejected for new dispatch comparisons

Runtime measured:
- core `1.3.0-nredd.10` (brew), stack `stack/1872f0cc`, `~/.local/bin/pi` wrapper, node via `enableCompileCache`
- host: 10 CPUs, AC power. Load averages are in each report's `host`, other agents were running so p90 is noisy

Results, ms, 10 runs, gap 0.5, shipped runtime (load 3.9):

| variant | first_paint | frame | input_ready |
|---|---|---|---|
| wrapper `pi` | 738 / p90 753 | 750 / 776 | 768 / 794 |
| direct core binary | 693 / 714 | 716 / 730 | 734 / 748 |

- The wrapper's `fast_gate` costs ~35 ms over the core binary. It lives in dotfiles, not this repo, and was not changed
- Idle gap of 25 s (load ~9, 5 runs): median input_ready ~1000 ms before the fix, 792 ms after

Raw reports (all samples, per-phase summaries, host load and power) are in `integration/baselines/startup-reports/`: `installed-warm.json`, `before-after-warm.json`, `before-after-idle.json`. `startup.darwin.json` holds only milestone medians for `--baseline`.

Where the time goes (direct binary, medians; `main:createAgentSessionRuntime` is ~470 of ~485 ms of `main:TOTAL`):
- Process start to `main` plus paint after it: input_ready 734 minus `main:TOTAL` 482 = ~250 ms (node boot, core bundle load, first render), not split further
- Inside `createAgentSessionRuntime`: extensions `TOTAL` 427 (imports plus factories), so resource discovery and model init together are ~40 ms. `PI_TIMING` has no separate resource-discovery or `session_start` phase, so those are NOT separated here; that needs core instrumentation (follow-up in the core fork, not done)
- `@nredd/pi-subagents/src/index.ts` module import: 286 ms median, ~60% of it. Everything else is under 30 ms each (workflow 26, router 22, web-access 18, preset 16)
- `--cpu-prof` of the launch: the time is Jiti reading and transforming ~80 TypeScript modules (1.3 MB) per launch, `readFileUtf8`, `jiti.cjs`, `vm`. A fresh `TMPDIR` cost only ~180 ms once, so the Jiti cache is not the lever
- Pi with no extensions: `createAgentSessionRuntime` 55 ms

Fix: `packages/subagents` ships `dist/index.ts`, the same graph pre-bundled by esbuild (`packages: "external"`) with the shared root `scripts/runtime-builder.mjs`. `pi.extensions` targets it, `src/` stays packed for `createSubagentsExtension` consumers. `dist/` is gitignored build output (#866): `npm run build` regenerates it, `npm run check` and `make install-owned` build it, and `prepack` builds it for publish.

Before/after, profile copy with only the subagents manifest changed, 10 runs each, alternating, gap 0.5, load ~8:

| variant | first_paint | frame | input_ready | subagents import | createAgentSessionRuntime |
|---|---|---|---|---|---|
| before (`src/index.ts`) | 695 | 714 | 730 | 283 | 463 |
| after (`dist/index.ts`) | 427 | 427 | 444 | 9 | 189 |

- Median `input_ready` drops ~286 ms (39%). p90 and every sample are in `before-after-warm.json`; after p90 is inflated by host load (655 vs 444 median)
- The stock-Pi package contract (`make check-subagents-package-contract`) loads the packed tarball and a faux `Agent` call returns the child's answer
- No regression was demonstrated against an older build: no known-good artifact exists to compare. The slowness is the unbundled import, present since the package was imported

Open, not done here:
- `fast_gate` wrapper overhead (dotfiles)
- Remaining ~150 ms of other extensions' imports are small each; bundle them only with the same evidence
- Quiet-runner CI gate: needs a quiet runner and an evidenced rebaseline (see `integration/README.md`)
