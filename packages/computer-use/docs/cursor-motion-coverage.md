# Deterministic cursor motion checks

`npm run coverage:swift` compiles the real production Swift sources with
`cursor_motion_tests.swift` and `headless_tests.swift`. No source extraction,
replacement renderer, overlay, pointer movement, capture, activation or TCC is involved.

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
