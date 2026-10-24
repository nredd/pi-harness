# Quota fairness contract

This specifies the existing policy, not a new scheduler. No defaults, configuration,
provider calls or routing behavior change. Fairness means balancing **normalized quota
headroom per window, adjusted for reset pace**, not equal requests, tokens, dollars,
latency or local session usage. Provider percentages are account-wide observations:
other Pi sessions, other clients and outside use contribute to them.

## Actual policy

[`selection.ts`](../src/selection.ts) scores only fresh available snapshots. For each
applicable active finite window `w`:

```text
r_w = 1 - min(usedPercent_w, 100) / 100
f_w = clamp((resetAt_w - now) / durationMs_w, 0.05, 1)
s_w = r_w / f_w
s_model = min_w s_w
```

Negative/nonfinite utilization and passed finite resets are ignored. Missing or invalid
timing gives `f_w = 1`. Model-scoped windows count only for matching families. A fresh
unlimited snapshot ranks above every measured score; absent, expired, error, unavailable
or inapplicable data is fallback, below every measured score. Chain order breaks ties.
A positive credit balance alone is not unlimited.

[`Router.pick`](../src/router.ts) first filters unresolved models, missing credentials,
tracker blocks and cached exhausted applicable windows. Scores never deny admission.
[`UsageService.decisionFor`](../src/usage.ts) retains stale exhausted windows with a
known future reset; stale data does NOT universally fail open. Unknown/past reset stale
exhaustion fails open. A fresh unlimited snapshot does not bypass a tracker block.

- `ordered` selects the first eligible entry, irrespective of scores or incumbent.
- `balanced` without an incumbent selects the highest tier/score.
- A balanced new user prompt retains an eligible measured incumbent unless the best
  measured challenger beats `1.2 * incumbentScore` by more than floating-point tolerance.
  Exactly twenty percent improvement stays sticky. A zero-score incumbent yields to a
  positive measured challenger. Fresh unlimited incumbents and all-fallback incumbents
  stay sticky; a higher tier displaces a lower-tier incumbent.
- Eligible tool continuations and balanced direct calls retain the previous physical
  model without comparing scores. Non-quota retries retain the failed model; confirmed
  quota recovery reselects, refusing transparent replay of partial output.
- Admission/pick does not reserve capacity. Selection reads cached data only. Usage
  service caching/refresh coalescing and exhaustion tracking are in-process, not a
  cross-process quota ledger or lock. Multiple Pi processes do not coordinate dispatch.

## Conditional guarantees and proofs

These statements deliberately distinguish selection-time guarantees from accounting
models. The deterministic simulator calls the real `Router.route`, `Router.pick`,
`ExhaustionTracker` and `UsageService.decisionFor`; quota observations, clock and
physical resolution are fixtures. `CachedUsage.peek` is also substituted: it returns
mutable snapshots without production `peek`'s expiry-to-stale conversion. These tests
therefore exercise real dispatch/eligibility and scoring, not the production cache
lifecycle; usage tests cover that lifecycle separately. The reset test refreshes only
snapshot expiry to isolate passed-window scoring. No second routing algorithm is used.

### G1: best eligible candidate, without affinity

For balanced selection with no incumbent, the result has maximal tier and, within the
measured tier, maximal score among eligible candidates. Among equal maxima it is the
first chain entry. If no entries are eligible, selection fails.

Proof: the scan starts at the first candidate and replaces it only on strict improvement.
After each prefix its retained candidate is the first maximum of that prefix. Eligibility
filtering preserves order. This is a local selection property, not a throughput theorem.
`fairness.test.ts` exhaustively checks all `17^3 = 4913` fresh utilization triples on a
sixteenth grid, including exhausted entries and the all-blocked case. Existing
`selection.test.ts` covers tiers and floating-point ties.

### G2: symmetric independent fresh prompts

Assume equal capacities, initially equal usage, a common unchanged reset-time factor,
one applicable window per provider, identical fixed positive debit per dispatch,
instantaneous telemetry, no outside use, no incumbent, no exclusions and no exhaustion
within the interval. After each dispatch, counts differ by at most one; after each full
round of `N` dispatches they are equal.

Proof: G1 picks a minimum count because scores are a common decreasing affine function
of counts. Incrementing a minimum by one preserves count range at most one. Initial
range is zero. Tie order determines who gets a remainder, not the bound.

For unequal capacities and equal debit units, the same argument applies to normalized
consumption `u_i = debit_i / capacity_i`: selecting a minimum and adding at most `delta`
preserves range at most `delta`, starting at zero. Here `delta` is the largest normalized
single debit. It does NOT imply equal request counts. The tests use capacities `64:128`
and yield debits `32:64` after 96 independent prompts, with normalized skew at most
`1/64` throughout. These assumptions exclude normal incumbent-bearing conversations.

### G3: incumbent hysteresis is a band, not alternation

In the same fixed common-time accounting model, let remaining fractions be `r_i`, and
`r_max = max_i r_i`. Ignoring floating-point tolerance for this algebra, the selected
measured entry obeys `r_selected >= r_max / 1.2`: either it is the maximum, or the best
challenger did not beat the incumbent threshold. This holds before the next debit, not
after an arbitrarily large response.

For any finite number of initially equal accounts, no exclusions/exhaustion, fresh
observations on every new user prompt, no external debits and normalized per-dispatch
debit bounded by `delta`,
the post-dispatch range of remaining fractions is at most `1/6 + delta` while remaining
fractions stay in `[0,1]`. Only the selected fraction decreases. If it becomes a new
minimum, the new maximum is at most the old `r_max`, so the new range is at most
`r_max - r_selected + delta <= 1/6 + delta`. Otherwise the minimum is unchanged
and the maximum cannot increase, so the range cannot grow. Induction from equal
fractions proves the bound for both the two-account simulator and three-provider Pi
scenario. This is a finite interval invariant, not convergence to equal counts or a
no-starvation guarantee.

The implementation allows a small numerical tolerance `E` when comparing
`s_max - 1.2*s_incumbent`; the precise selection inequality is
`s_max <= 1.2*s_selected + E` when retained (zero has its special branch). For a common
factor `f`, the range proof gains at most `f*E/1.2` when selection creates a new minimum.
Power-of-two capacities do not avoid exact 20% boundaries: the sixteenth grid contains
remaining units `5:6` and `10:12`, where it explicitly asserts incumbent retention.
`selection.test.ts` also checks strict twenty-percent ties, just-over-margin switching
and percentage roundoff; these cases do not erase the numerical qualification.
For two capacities of 64, the actual router sends the first **eleven** prompts to the
first account, then switches on prompt twelve. Thus even fully fresh symmetric inputs
do not imply one-request skew when the incumbent is present. A real Pi faux-provider
scenario verifies that its persisted incumbent produces this same initial burst.

### G4: no anti-herding or reset-survival guarantee

No aggregate allocation bound follows from G1 across independent processes or delayed
telemetry. Sixteen clients with the same fresh tied snapshot all choose the first
account: all sixteen dispatches can target capacity eight before any observation changes.
Even a single router with a lagging snapshot sends twelve synthetic units to capacity
eight. Refresh redirects the *next* dispatch; it cannot retract previous work.

These are deterministic counterexamples, not stochastic performance estimates. The
multi-client fixture uses distinct Router instances with identical snapshots, no real
network or shared reservation. It models simultaneous admission, not provider acceptance
of every over-capacity request. The provider may reject excess requests.

## Exclusions and non-guarantees

- Arbitrary offered load, expensive long-tail responses and sticky continuations can
  exhaust quota before reset. There is no pacing, reservation, predictive cost model,
  token-to-quota conversion or guarantee of finishing work before any window exhausts.
- Outside use may dominate account utilization. Equal local counts need not be desirable;
  account-wide feedback can correctly send every local request elsewhere.
- Multiple windows use the minimum, not a sum. A family window can dominate provider
  headroom; different reset times change scores without any debit. The 5% time floor,
  resets, changing limiting windows and varying eligibility invalidate the fixed-factor
  proofs. Passed windows disappear until fresh telemetry supplies the next window;
  the router does not invent a refill.
- Unlimited entries may take every dispatch indefinitely. Measured entries can dominate
  fallback entries indefinitely; all-fallback affinity/chain order provides no fair share.
  Missing credentials and confirmed blocks exclude candidates entirely.
- `ordered`, continuations, direct affinity and retry affinity are not covered by G2/G3.
  Shared provider quota across several chain models does not create independent capacities.
- No general no-starvation, bounded waiting, equal token share, statistical fairness or
  no-early-exhaustion claim is made. These tests are reproducible conditional proofs and
  counterexamples, not live provider billing validation.

## Evidence and next decisions

`test/fairness-simulator.ts` accounts synthetic debits, publishes or withholds telemetry,
and calls production dispatch. `test/fairness.test.ts` covers G1-G4, external usage,
long-tail debits, unlimited/stale/missing observations, model windows and reset exclusions.
The expensive-prompt case exceeds the unit-cost premise (`delta = 1/64`), then checks
that fresh telemetry redirects the next independent dispatch. It does not refute the
bound with `delta = 2` or claim the provider would accept that oversized debit.
`test/scenarios/fairness.test.ts` exercises real Pi with credential-free faux providers
under both Vitest and Bun; it asserts physical dispatch and keeps the selected model
virtual. Existing selection/router/usage suites cover confirmation, exact boundaries,
eligibility and the remaining reset parsing cases.

Phase 1 only records policy and tests it. Configurable `switchMargin` and cross-process
anti-herding policy remain user decisions. No new switches or production changes are
introduced here. Neither changing the margin nor random tie-breaking alone establishes
a global capacity guarantee with delayed account-wide telemetry.
