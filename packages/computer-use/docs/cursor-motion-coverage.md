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
of `200/25`. These denominators are deliberately distinct. #772 reduced
source-view misses to `0/0/5` with the same denominator, without changing production.

## Numeric boundaries (#810, #645)

At base `5e2217604f65da789355da68c0e0289be25846cb`, a fresh real-source
producer run confirms motion misses `0/0/5` of `212/25/92`. The finite-input
boundary assertions reduce these to **0/0/0**, preserving every safeguard and
all five production files. Three existing pure helpers become module-internal;
production formulas and callers are unchanged. The tests reach:

- `rotateToward`: the negative-wrap loop body, through the pure turn seam.
- `mod2pi`: negative-remainder correction for subnormal rounding.
- `dubinsLSL` and `dubinsRSR`: negative squared-distance guards under cancellation.
  These squared distances are nonnegative in exact arithmetic, not floating point.
- `planDubins`: no accepted solution when finite pose arithmetic overflows.

Finite cases now exercise the negative turn directly, normalize the negative least
subnormal Double, plan both signs of a near-coincident circle-center configuration
(`separation = 0.00627`, radius 80), and run overflow rejection/linear fallback from
`1e200` to `-1e200`. Assertions check exact angle correction, finite path length,
endpoint error below `0.00001` and finite renderer state with the visual heading.
These are not exhaustive floating-point proofs. Defensive arms remain intact.

Executable drop controls remove negative wrapping, remove subnormal correction
and refuse every candidate, and require the corresponding behavioral assertions
to fail. These controls establish assertion sensitivity, not a claim that every
individual solver guard has its own independent mutation proof.

The bounded follow-on pure policy table in `headless_tests.swift` checks US
alphanumeric, punctuation and shifted-symbol mappings, empty input and a selection
length mismatch. It constructs no events and makes no AX queries. A wrong Shift
bit for `?` must fail. It reduces `bridge.swift` missed LLVM regions from 2132 to
2122 of 2471, with source-view lines/functions unchanged at 4511/662 missed of
5161/791. No Bridge runtime changes are needed.

Other source-view misses remain: `activity_glow.swift` 152/27/39 of 152/27/39,
`agent_cursor.swift` 162/19/38 of 162/19/38, and `helper_entry.swift` 5/1/3 of
5/1/3 (L/F/regions). #645 stays open. Native policy caps are not tightened from a
local-only receipt; exact-HEAD hosted artifacts remain required for admission.

The producer retains source hashes, compiler argv, binary/profile hashes and raw
LLVM exports in `coverage/swift/`. LLVM regions are NOT branch or statement
outcomes. Absent branch/statement records remain unmeasured, not zero. No physical
desktop behavior is claimed. Live capture/auth #688 remains out of scope.
