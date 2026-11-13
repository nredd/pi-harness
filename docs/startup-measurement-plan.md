Audience: maintainers collecting #577 evidence. This is a measurement protocol, NOT an executed
benchmark or permission to launch a live profile. #577 stays open until controlled evidence exists.

Frozen synthetic control inputs:
- Harness source baseline: `5e2217604f65da789355da68c0e0289be25846cb`. Preserve the final measurement
  harness commit as well. Readiness method: `command-dispatch-v1`, not historical tty echo.
- Faux provider: `integration/providers/faux.ts`, SHA-256
  `f3cae970fae99fdca8036f07217cf2fde440190609dacb37b1d77926c26af383`.
- Runtime preload adapter: `integration/harness/runtime_hooks.py`, SHA-256
  `6709f1e7469c4054796df8ac4c09d820e4d5619d5568dd99ed40e96698b64232`.
- These are pinned SOURCE inputs, not authenticated runtime archives or a full profile inventory.
  The existing native no-network scenario in `integration/scenarios/test_startup.py` is a minimal
  correctness control. It is NOT personal/enterprise-equivalent performance evidence.
- For a differential, `.10` coding-agent archive candidate SHA-256 is
  `ac42b4317b85182065606cc8a526ec157f4c950a7b74f3410eed110a22bf8903`, core source
  `4d857379f37f83397871a66c522abbe8469a003d`. Authenticate its published `SHA256SUMS` and
  `fork-release.yml` provenance before execution. This protocol does not claim fresh verification,
  a known-good historical latency baseline or reproducible byte-for-byte rebuilding.

Before any acceptance run:
- Reserve a quiet runner/window with the owner. Record the reservation, OS/runtime/architecture,
  logical CPUs, load, interval CPU, available memory/pressure and AC state before/after every pair.
  Predeclare the quiet-host admission criteria with the owner before collecting data. A loaded host
  can supply correctness diagnostics only; never relabel it quiet or discard slow samples silently.
- Save a private identity receipt for EACH build: selected launcher file SHA-256, resolved core archive
  digest and provenance, bundle member manifest digest, full core commit, runtime version/flags and
  compile-cache policy. Verify supported timing flags by executing that exact artifact in isolation.
  Do not infer identity from a pin or source checkout. Authenticate a second build separately.
- Assemble TWO versioned synthetic package-policy fixtures: `personal-equivalent` and
  `enterprise-equivalent`. Use public packages with exact artifact integrities and resource filters;
  never copy workstation settings, enterprise manifests, provider inventories, endpoints or auth stores.
  The names describe policy coverage, not a claim to reproduce an owner's private profile.
- Pin an ordered manifest of every extension artifact and its synthetic timing alias; deterministic
  settings, prompts, skills, agents, themes and resume-session bytes; source file hashes; faux model
  definitions; cached-quota fixture age/values; and virtual-tier bindings. Hash each fixture's ordered
  path/digest manifest. Native package loading, registration, cached routing and virtual-tier behavior
  must remain enabled. No blocking quota refresh. Keep credentials absent, HOME disposable, workdir
  empty and unrelated MCP servers disabled. `PI_OFFLINE` alone is insufficient network isolation.
- Use the existing runtime preload adapter with a network-denying guard and per-launch loaded nonce.
  Require zero provider requests AND zero blocked network attempts. Preserve runtime flags. A missing
  or failed guard acknowledgement invalidates a sample, regardless of an empty request log.
- The full equivalent fixture manifests and a phase-capable authenticated runtime artifact are still
  REQUIRED inputs, not supplied measurements. Coordinate core phase work with the lifecycle owner
  before editing core; this harness change does not write core or alter any release/pin/configuration.

Phase admission:
- Require opt-in, allowlisted, bounded, monotonic events for launcher/package verification, resource
  discovery, extension imports/factories, provider/virtual-model registration and offline refresh,
  completion of ALL `session_start` handlers, first paint and command dispatch. Record the producer
  schema/clock and exact artifact identity. Missing events are unknown, never zero.
- The nonce command proves an observed dispatcher acknowledgement, including tmux overhead. It does
  not prove all-handler completion. Existing `PI_TIMING` wall-clock deltas cannot fill those gaps.
  Never subtract unrelated totals to manufacture a missing phase or blame a particular package.
- Core instrumentation and profile fixtures need their own offline success/failure/cleanup tests.
  Verify no instrumentation output/work when disabled and no private labels when enabled. Phase
  attribution precedes any critical-path optimization or choice of new latency threshold.

One build, four cells, five pairs per cell, 40 launches:

| cell | synthetic profile | session |
|---|---|---|
| 1 | personal-equivalent | fresh |
| 2 | enterprise-equivalent | fresh |
| 3 | personal-equivalent | deterministic synthetic resume |
| 4 | enterprise-equivalent | deterministic synthetic resume |

- Run five rounds. Cell order is `1,2,3,4` on odd rounds, `4,3,2,1` on even rounds. Within EACH
  cell/round, launch `first` then immediately `warm`, sequentially, never concurrently.
- Allocate a new disposable fixture HOME/cache/session directory for EVERY pair. First launch uses
  that new fixture; warm launch reuses its exact HOME/cache. Both fresh-session launches start new
  sessions. For resume cells, restore the same pinned synthetic session bytes before each launch,
  leaving runtime caches intact. Never call first-fixture launch OS-cold.
- For two authenticated builds, execute both five-round matrices: 80 launches total. Alternate build
  order per cell/round (`A,B`, then `B,A`); each build gets independent directories. Do not claim the
  40-launch single-build matrix supplies two-build before/after evidence.
- Keep chronological order, individual samples and identity digests, round/cell/build/pair labels,
  first/warm state and before/after host observations. Preserve invalid samples with explicit reasons;
  never aggregate them as acceptance. Retain incomplete runs as incomplete, not a smaller green gate.
- Publish sanitized per-cell first/warm phase and readiness samples plus medians/dispersion only after
  reviewing identities and metadata. No raw stderr, private prose, transcript text or host associations.
  Store a future accepted baseline in a NEW file; existing benchmark history remains unchanged.

Remaining acceptance:
- Owner/parent: reserve the quiet runner and approve quiet-host criteria; coordinate a disjoint core
  instrumentation issue/artifact with the lifecycle writer. Do not silently add core writes here.
- Measurement owner: finish both synthetic equivalent artifact inventories, authenticate runtimes,
  execute and retain the entire matrix, then report whether a regression was demonstrated. Minimal
  controls/package exclusions are diagnostic only, not a shipping configuration or full acceptance.
- Fix ONLY an evidenced critical path. No demonstrated regression means report that outcome, not a
  speculative optimization. Exact-HEAD reviews, parent critic, CI and protected explicit merge remain
  mandatory for each code change; no auto-merge, activation or release is authorized by this protocol.
