# Routing policies v1

`policy` opts a profile into versioned semantics. It is mutually exclusive with `strategy`.
Omitting both still means legacy `ordered`; existing profiles are never migrated. The shipped
[JSON Schema](../schemas/subscription-router.schema.json) describes the closed policy union.
Runtime validation also rejects duplicate physical references. Unknown policy keys and unsupported
versions fail the entire config with a path-qualified error. Legacy outer/entry keys stay permissive.

```json
{"policy":{"version":1,"kind":"remaining-balanced"},"chain":[{"model":"anthropic/claude-haiku-5-5"},{"model":"openai-codex/gpt-6-luna"}]}
```

Policies:
- `strict-priority`: first eligible chain entry on every allocation, including continuations and
  direct requests. Immediately fails back when earlier quota recovers. This can lose prompt cache.
- `remaining-balanced`: highest minimum raw remaining fraction across all reported applicable active
  windows. Unlike legacy `balanced`, this never divides by time until reset. Defaults to continuation
  stickiness and zero prompt switch margin. Direct and user requests rerank, including ties.
- `lexicographic`: `by` accepts a single `remaining` descending metric, optionally followed by
  `chain-index` ascending, or chain index alone. Chain index is appended when omitted. Remaining
  requires `window: "binding"` or `window: {"name":"seven_day_fable"}`. Missing named windows are
  unknown, not free capacity. Prefer binding for cross-provider policies.

Optional `stickiness: "none"|"continuation"` defaults to continuation for remaining-bearing forms,
none for chain-only. Optional `switchMargin` is finite in `[0,1]`, legal only with a leading remaining
metric, and applies only on user requests. Zero (also omission) disables incumbent retention even
at measured/unlimited/unknown ties. Positive margin retains an eligible incumbent unless a challenger
beats `(1+margin)*incumbent` beyond subtraction roundoff, or promotes its knowledge tier. A zero
incumbent yields to any positive score. `strict-priority` accepts neither knob.

Evaluation order is mandatory registry/auth, confirmed block and cached exhaustion filters, then
declared sticky boundary, lex ranking, then prompt hysteresis. Unknown filter outcomes have an explicit
pass/reject rule. Ranking knowledge is fresh unlimited, measured, unknown; ties use stable chain order.
The core evaluator consumes observations and an injected timestamp, without network, RNG, wall-clock
reads or mutation. Caller defaults to `unknown`; v1 is caller-independent. Never infer workload class
from request reason or agent names.

Provider-wide windows apply to every member; family windows require whole-token matching. Only valid
nonnegative utilization is measured; above 100 clamps to 100. Expired reset evidence is inactive, not
an invented refill. Remaining is the minimum over selected active windows, retaining all tied limiters.
Missing, failed or older stale telemetry remains usable fallback. Scoring trusts available/stale data
through the existing 15-minute-from-retrieval grace after the five-minute TTL; stale unlimited is not
unlimited. Blocking remains separate: an exhausted window with a future reset stays blocked even after
scoring grace expires. Adding model references never creates provider capacity.

Legacy `ordered` and `balanced` compile to legacy affinity and reset-headroom primitives. They retain
historical numeric operations, 20% margin, direct/continuation affinity, serialized decisions and timing
of safety checks. `ordered` is NOT strict priority. All policies retain unconfirmed transport retries on
the failed member, confirmed-quota-only failover, partial-output replay refusal and per-turn terminal
recovery caps. `wait|fail`, first blocker/minimum wake hints and tier isolation are unchanged. A wake is
only a recheck hint; dispatch may park again. No policy borrows a different router profile.

`/router explain <profile> [--json]` is a cached-only fresh-dispatch forecast with no incumbent, refresh,
decision persistence or affinity mutation. JSON includes policy expansion, caller/reason/forecast,
filter verdicts, snapshot age/TTL/grace, applicable active/inactive windows, limiters, tuples, overrides,
chain tie-break and chosen member or empty reason/recheck hint. It omits credentials, URLs, headers,
balances and raw errors. A forecast can differ from the actual incumbent-bearing route.
New-policy `router:decision` traces include version 1 evaluation, including sticky/retry decisions.
The last five requesting-session traces are in memory; only first choices and changes persist. This is
not a full durable audit. Legacy traces remain unchanged; scores never enter prompts.

Fairness is conditional, not a no-starvation promise: fresh independent prompts with finite independent
quotas, positive bounded debits, no outside usage, affinity, resets or exclusions eventually spend every
persistently eligible member's headroom. Equal debits keep remaining skew within one debit. Fixed
snapshots, unlimited rivals, shared quotas and indefinite continuations are counterexamples. Admission
is a forecast, not a reservation; simultaneous fan-out can herd on the same cached winner.

Later phases remain in #741: trusted caller context and reserves/thresholds, capability/cost metadata,
session affinity, inference health/recovery, burn-history pacing, bounded parking, weighted exploration,
provider grouping, reservations/coordination, production replay and latency optimization. V1 rejects
these unimplemented policy operators and `policyByCaller` alongside a policy.
