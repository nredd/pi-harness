# Deterministic cursor motion checks

`npm run coverage:swift` compiles the real production Swift sources with
`cursor_motion_tests.swift` and `headless_tests.swift`. No source extraction,
replacement renderer, overlay, pointer movement, capture, activation or TCC is involved.

## Default invariant gate and live opt-in (#819)

`npm run test:invariants` keeps the Swift source typecheck, invalid-source/cache
controls and deterministic cursor-motion lifecycle enabled. Its cursor binary also
checks the live-selection gate using fake callbacks: absent, empty, `0`, `true`
and whitespace-padded values refuse the callback; only exact `1` invokes the fake.
These fake callbacks never create windows, even when testing opt-in selection.

The real `testOverlayLifecycle` callback constructs and orders AppKit windows.
It is **NOT RUN** by default; the native binary reports that boundary and the
invariant runner preserves that output. Run it only in an authorized desktop window:

```sh
PI_COMPUTER_USE_LIVE=1 npm run test:invariants
```

This opt-in also applies when invoking the native cursor test binary directly.
The default `npm test`/`npm run check` must run without that flag in headless CI.
`test/cursor-headless-gate.test.mjs` rejects the former unconditional call graph
without executing Swift/AppKit. Revert controls restore the unconditional call or
remove the exact opt-in guard and must fail those source assertions, never run the
mutated native executable. The real-source coverage producer and its denominators
are unchanged; the live fixture is not included in that producer.

The earlier nominally headless invariant suite called `testOverlayLifecycle`
unconditionally and ran real windows during #645. That execution was not wholly
desktop-free. No input events, TCC grant, authentication UI, capture or clipboard
operation was intentionally invoked. This repair does not turn that old execution
into authorized live acceptance. Current live acceptance remains NOT RUN.

The separate static parity-control isolation belongs to #818/#825. Those controls
must target the unchanged JavaScript-only predicate rather than prepare the Swift
SDK. No wrapper, SDK hook, source-validation, cache-control or cursor deadline
changes here.

## Motion assertions

The motion assertions cover:

- Linear sampling below, within and above its distance range, with heading wrap in both directions.
- Analytic radius-two left/straight/right segment positions, headings and boundaries.
- Zero, near-zero and just-over-threshold renderer targets, including the linear planner fallback.
- Finite planner geometry in every quadrant at distances 1, 40, 160 and 800.
- Clock initialization, fifty-millisecond frame clamping, bounded turns during repeated
  in-flight retargeting, final visual offset/heading, cancellation, reset and idle ticks.

Removing the production linear sampler's clamp (`let u = s / length`) must fail
`linear distance clamps below zero`. Restore the source before collecting coverage.

The #765 hosted baseline (`ea5e7ee4`, merged as `c00e4196`) has motion source-view
LLVM uncovered L/F/regions `11/1/19` of `212/25/92`, and LCOV uncovered L/F `11/1`
of `200/25`. These denominators are deliberately distinct. The new local run reduces
source-view misses to `0/0/5` with the same denominator, without changing production.

Remaining zero regions, not hidden or reclassified:

- `rotateToward`, line 108: the negative-wrap loop body. The renderer starts each path
  at its visual heading plus pi, then adds pi on sampling; normal motion therefore
  starts with a positive two-pi difference. The turn follower runs at 14 rad/s,
  faster than the planned maximum 900/80 rad/s. Both linear wrap bodies are tested
  directly, but finite monotonic-clock renderer scenarios have not reached this body.
- `mod2pi`, line 167: negative-remainder correction. In exact arithmetic
  `x - tau * floor(x / tau)` is nonnegative. This is a floating-point safeguard;
  no finite production geometry tested here reaches the correction.
- `dubinsLSL` and `dubinsRSR`, lines 175 and 182: negative squared-distance guards.
  Algebraically these are squared distances between same-turn circle centers:
  `(d +/- (sin(a) - sin(b)))^2 + (cos(a) - cos(b))^2`. They are nonnegative
  in exact arithmetic, but cancellation can matter in floating point.
- `planDubins`, line 246: no accepted solution. Same-turn circle paths exist for
  finite poses with positive radius, so at least LSL or RSR supplies a solution
  mathematically. The guard still protects against numerical failure of candidates.

These are reachability arguments, not exhaustive floating-point proofs. None of
these defensive arms is deleted, forced with nonfinite inputs, ignored or exempted.
The raw LLVM artifact retains all five misses and all five production files. No
branch/statement coverage or physical desktop behavior is claimed. The overlay,
bridge and helper-entry thin-adapter exemptions remain separate policy decisions.
