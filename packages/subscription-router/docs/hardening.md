# Router hardening evidence

Scope: current-main `0.4.0` sources, without changing scoring, hysteresis, quota thresholds,
installation pins or OAuth ownership. No release or live-provider acceptance is implied.

## Coverage matrix

| Boundary | Execution | Assertions |
| --- | --- | --- |
| Partial-stream terminal quota / retry | `test/scenarios/recovery.test.ts`, real Pi session + faux streaming deltas, Vitest and Bun | Text appears once; no alternate dispatch; failed tool calls do not execute; prior successful tool effect occurs once |
| Empty-error recovery | Same scenario suite | Only confirmed quota switches; failed assistant omitted; prior assistant/tool result retained; physical models and exact request counts |
| Transient failure | Same scenario suite | Three core retries, four attempts on A, zero on B, no quota mark without confirmation |
| Cancellation at settle | Same scenario suite | Core suppresses continuation after abort; a completed quota confirmation may remain marked because the settle context has no streaming abort signal |
| Balanced selection / continuation | `test/scenarios/balanced.test.ts`, Vitest and Bun | Six existing three-provider scenarios retain scoring, hysteresis, continuation stickiness, stale and unmeasured fallback |
| Direct `subscription_usage` | `test/scenarios/usage-tool.test.ts`, real tool dispatch, Vitest and Bun | Malformed payload, unavailable credentials, credential-owner exception, HTTP failure, retained stale data, invalid reset; sanitized text/details; one tool result |
| Tool cancellation | Same tool scenario | Caller detaches, another caller completes the shared read; no response text emitted. Core invokes one already-aborted continuation stream, which the faux transport refuses; this is not proof of any live SDK's cancellation behavior |
| Concurrent reads | `test/usage-races.test.ts` | Older success cannot overwrite newer exhaustion; older failure cannot install backoff or downgrade newer data using a captured stale snapshot |
| Cancellation / unknown collector | Usage tests | Pre-cancelled refresh consumes no allowance and reads no credentials; inherited object-property names are not collectors |
| Credential owner | Usage tests | Rejection is sanitized; a stalled lookup releases router callers after ten seconds and backs off; router performs no refresh/persistence itself |
| Reset and backoff | Existing usage/router/selection tests | Past/equal resets, stale exhausted windows with future reset, failed-read backoff, Retry-After cap, shared confirmations and family scope |
| Packed default entry | `scripts/package_contracts.py` on stock Pi 1.3.0 | Virtual model discovery, physical dispatch, invalid config rejection, tool surface and sibling absence |
| Packed multiprovider | Same stock host + `scripts/router_contract.mjs` | Installed factory bytes; B wins balancing, C remains unmeasured fallback, A's SSE quota failure confirms then recovers to B; exact message order, request counts and successful settlement |
| Subagent admission | Existing `integration/inprocess/router-admission.test.ts`, both runtimes | Wait/fail/capped refusal through real router and subagent factories |

Packed multiprovider model calls go to three independent loopback servers. The usage transport is
synthetic and injected into the real packed `UsageService`; it does not redirect live endpoints or
load owner credentials. The original default-entry test remains separate from the embedding fixture.

## Red proofs

These assertions failed before their corresponding fixes, not just after increasing test counts:

- Both partial-stream scenarios received `already visiblealready visible` instead of `already visible`.
- Superseded-success race replaced the newer exhausted snapshot; superseded failure installed backoff
  and prevented the next read. With a preexisting snapshot, the older failure replaced fresh 100%
  data with stale 10% data. A superseded response also reported itself `available` despite not
  owning the shared snapshot used by confirmation; it now returns a sanitized error.
- A pre-cancelled force read consumed the manual allowance; the next real request returned `error`
  instead of `available`.
- A finite but unrepresentable `1e100` reset caused `RangeError: Invalid time value` in `decisionFor`.
- A never-resolving credential owner left the request unsettled after the ten-second bound.
- `__proto__`, `constructor` and `toString` attempted credential resolution instead of returning
  `unavailable` without lookup.

The fixtures that previously cast incomplete error objects now include actual assistant content.
Concurrent-read tests wait for recorded request starts, not an assumed number of promise microtasks.
No test deadline, routing threshold or retry allowance was relaxed.

## Ownership and limits

The router delegates credential acquisition/refresh to `modelRegistry.getApiKeyForProvider`.
It bounds its own wait to ten seconds, then uses existing failure backoff. It cannot cancel that
core API: a late result is ignored by this router read, but core may still finish its own work.
The subsequent HTTP request has a separate ten-second abort timer. Injected transports are expected
to honor that HTTP abort signal, like native fetch; the router does not promise to terminate arbitrary
noncooperative custom transports.

Process-global caches are intentionally shared by provider. Cross-process account switching and
real token refresh/revocation remain core/collector integration risks, not simulated guarantees.
Clock tests use an injected epoch clock; quota reset times are wall-clock values. No monotonic-clock
rewrite or new policy threshold is included. Provider-supplied date values outside JavaScript's
representable range become unknown resets rather than crashing routing or prompt formatting.

Native SDKs might discard partial output before exposing an error to the router. The refusal guard
covers the content Pi supplies; it cannot detect bytes a provider adapter has already discarded.
The router never executes tools itself. Host tool scheduling, SDK retries and OAuth persistence
remain host responsibilities.

## Gate record

Local macOS development gate: `make check` passed on Node 26.12.0, npm 11.20.0, Bun 1.3.14,
Python 3.13.15, with the existing Codex 0.154.0 binary and fresh private Codex/cache directories.
The gate ran under `caffeinate -is` on AC after checking host load and concurrent processes.
Router: 144 Vitest cases, including 20 real-session cases repeated by Bun, not 164 distinct tests.
Stack in-process: 64 Vitest and 64 Bun. Scripts: 533; integration units: 251; benchmark units: 91,
92.98% coverage, including the actual credential-free Codex sandbox boundary.
Existing unrelated skips/live exclusions in the root gate remain exclusions, not passes.
`make check-package-contracts` also passed, including the three router multiprovider scenarios,
all original standalone plugin contracts, resource-sampler consumer and preset audit/install.
PR CI is separate exact-HEAD evidence; local macOS is not Linux or standalone acceptance.

## Proposed live smoke, not run

Requires explicit owner authorization and separate approval of credential handling:

1. Use an isolated verified package install and core-owned OAuth store, never print tokens or copy
   them into artifacts. Owner initiates any required login/refresh.
2. Request one usage snapshot per collected provider, no forced repeated refresh and no exhaustion.
3. Permit at most one tiny response per provider (e.g. 16 output tokens), no tools, no retries,
   no subagents; record only status, physical provider/model and sanitized timing.
4. Cancel one synthetic/local request separately. Do not create live quota failures or revoke the
   owner's active credentials just to manufacture a boundary.

Budget: two usage HTTP reads and at most two minimal model calls. Subscription capacity may be
consumed and provider billing depends on the selected credentials/plan; no paid probe is authorized
by this proposal. Real refresh-expiry/revocation and quota-boundary acceptance remain unverified even
if this smoke passes. No finite suite makes the package bulletproof.
