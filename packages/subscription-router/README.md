# pi-subscription-router

Published to npm as `@nredd/pi-subscription-router` (public). From `0.4.0`, each version is cut by the monorepo `Publish` workflow from a signed `@nredd/pi-subscription-router@<version>` tag, with npm provenance and a GitHub release carrying the tarball, checksums and manifest (`docs/releases.md`); earlier versions were published manually without provenance. `0.4.0` adds `createSubscriptionRouter(options)` (explicit `config` and `usage`, injectable `tracker` and `now`; the default export is unchanged).
Use the [monorepo development commands](https://github.com/nredd/pi-harness/blob/main/README.md). The Git install
below describes legacy deployment, not installation or candidate verification of this package.

## Standalone use

The packed tarball is self-contained: Pi host modules (`@earendil-works/pi-*`, `typebox`) are `*` peers supplied by Pi, there are no runtime dependencies and no sibling plugin is required. Verified by installing the tarball alone and running it in exact stock Pi 1.3.0 (`make check-package-contracts`). Optional fork integrations (subagents, Plan mode) are absent in that setup; the exercised behavior does not need them.

`router/<profile>` virtual models for pi (>= 0.99) that route across included subscription quota.
Each profile has a chain of physical models and an optional routing strategy. Ordered routing
(default) picks the first eligible model. Balanced routing spends fresh cached quota according
to remaining capacity and reset timing, without adding network reads or changing quota blocks.

Install:

```sh
pi install npm:@nredd/pi-subscription-router@0.4.1
```

Config lives in `<agentDir>/subscription-router.json` (`~/.pi/agent/` by default). No file means
no virtual models. An invalid file is rejected whole and reported on session start.

```json
{
  "profiles": {
    "default": {
      "chain": [
        { "model": "anthropic/claude-sonnet-5-5" },
        { "model": "openai-codex/gpt-5.6-terra", "thinking": "high" },
        { "model": "anthropic/claude-sonnet-5" }
      ]
    }
  }
}
```

The shipped [cheap profile](examples/subscription-router.json) is opt-in: merge its `profiles.cheap` into this file to register `router/cheap`. It uses `strategy: "ordered"`, Haiku 5.5 then GPT 6 Luna, and `exhaustionPolicy: "wait"`. This keeps dispatch inside the inexpensive model class and prefers the first healthy entry, rather than letting headroom reorder the chain. It never borrows `default`, `deep` or `review`; if both are exhausted admission parks or fails under the ordinary policy. Models and pricing are explicit configuration, not a live price catalog. Nothing is installed or registered just by importing the router.

The shipped [frontier profile](examples/subscription-router.json) is opt-in the same way: merge `profiles.frontier` to register `router/frontier` for the hardest design and architecture work, which skills and agents reach as `@frontier`, never by model id. It uses `strategy: "balanced"`, Fable 5.1 and GPT 6 Astra, `exhaustionPolicy: "wait"`, no `maxWaitMinutes` and no `thinking` pin. The two are peers, so headroom picks rather than chain order. It never borrows `deep`, `default` or `review`; if both are exhausted admission parks or fails under the ordinary policy. Fable is not free headroom: it spends the provider-wide Anthropic `five_hour` / `seven_day` windows that `default` and `deep` share, and is also capped by its own Fable-scoped weekly window (`seven_day_fable`, below).

- `strategy` (`"ordered"` default, or `"balanced"`) selects chain-order routing or reset-aware balancing. Opt in per profile, e.g. `"strategy": "balanced"`; arbitrary chain lengths and providers work, unknown collectors remain usable fallbacks
- `exhaustionPolicy` (`"wait"` default, or `"fail"`) says what a dispatcher that can wait (pi-subagents background jobs) does when every quota-eligible entry is exhausted: park until the earliest reset, or fail now. `maxWaitMinutes` (default unlimited) caps how far ahead a reset may be waited for, and a reset that is unknown always fails. Foreground requests cannot wait and fail either way
- `thinking` pins that entry's level. Without it the selected level passes through
- With `enabledModels` / scoped models, add `router/<profile>` there too

Versioned policies are explicit opt-ins: `policy: {"version":1,"kind":"strict-priority"}`
provides unconditional chain priority at allocation boundaries; `remaining-balanced` balances the
binding raw remaining percentage, not reset-normalized headroom. A bounded `lexicographic` form,
continuation stickiness and configurable prompt margin are also available. Do not combine `policy`
with `strategy`. Semantics, schema and cached `/router explain <profile> [--json]` diagnostics are
[here](#routing-policies-v1); opt-in examples are [here](examples/policies.json). Existing examples and
legacy strategies keep their behavior and serialized decisions.

Routing (legacy strategies):

- Ordered `user`, `direct`: first eligible entry, unchanged
- Balanced `user`: highest-ranked eligible entry, with incumbent hysteresis below
- Balanced `direct`: stays on the eligible previous model when supplied, otherwise uses the balanced pick
- `continuation`: stays on the model that last answered, unless unavailable or quota-blocked; balancing applies only when it must leave
- `retry` (upstream auto-retry, e.g. a 429): refreshes usage. Confirmed -> mark and advance. Otherwise retry the same model
- All blocked: the request fails with the earliest known reset

Balanced scoring (conditional fairness guarantees and exclusions [here](#quota-fairness-contract)):

- For each applicable provider/family window, `remaining = 1 - usedPercent / 100`, `timeLeft = clamp((resetAt - now) / durationMs, 0.05, 1)`, `score = remaining / timeLeft`. The tightest (minimum-score) window limits the model. Past/equal reset windows are ignored; missing usable reset/duration uses `timeLeft = 1`
- Fresh unlimited ranks above measured, then missing/failed/empty/non-applicable usage. Ties retain chain order. Usage whose snapshot is at most `STALE_GRACE_MS` (15 min, `src/selection.ts`) old, measured from retrieval (about 10 min past the 5 min TTL), still scores as measured, flagged `stale` in status and the decision log, so a child's first route is not biased to `chain[0]` by a racing background refresh; older stale usage is fallback. Stale unlimited is never unlimited
- New prompts keep an eligible measured incumbent unless the challenger is *strictly* more than 20% better (floating-point normalization and boundary roundoff are treated as a tie, including near-exhausted windows). A measured challenger promotes an unmeasured incumbent; if all are unmeasured, the incumbent stays. Fresh unlimited promotes measured and remains sticky
- The same pure scoring and cached selection feed routing, recovery, admission and status. Scores never block quota, fetch data, or enter the system prompt. Adding a provider needs only a normalized collector and chain entry, not another algorithm

Eligibility never hits the network. An entry is skipped when a confirmed block covers it, when
cached usage already shows its window exhausted, or when it has no credentials. Stale or failed
usage fails open, except stale data whose known reset is still ahead.

Blocks are per `(provider, family)`: the Anthropic `seven_day_sonnet` window blocks Sonnet and
leaves Opus eligible. Anthropic reports some model caps only in its `limits` list, e.g. Fable as
`{ "kind": "weekly_scoped", "scope": { "model": { "display_name": "Fable" } } }` with no
`seven_day_fable` key. Each becomes a 7d `seven_day_<family>` window for the lowercased display name
(skipped when that is not one token, when the top-level key already reported it, or when a non-null
`scope.surface` or `scope.model.id` narrows the cap), so an
exhausted Fable cap blocks `claude-fable-*` and leaves Opus and Haiku eligible. An id- or
surface-scoped cap is not enforced (fail-open): a 429 against it still falls through the normal
retry path. A block lasts until the reset the provider reported. Without one it backs off
5 minutes, doubling up to 60.

Confirmation needs live data read after the failure: a cached or in-flight read from before the
error's timestamp doesn't count, while simultaneous failures still share one request. A failed or
backed-off read confirms nothing. If a later failure supersedes an in-flight read, earlier callers
follow the newer read (or its fresh cached result), rather than treating supersession as failure.
If that newer read is unavailable, an earlier caller may use its own successful snapshot started at
or after its `notBefore` boundary. This fallback never writes shared cache or backoff state: the
newer failure's backoff remains in force. A newer successful snapshot remains authoritative.
At the caller's 20-second deadline, a still-pending newer read cannot hide already completed live
evidence: the caller uses the newest qualifying success in its supersession chain (or cache).
Cancellation never uses this fallback, and neither deadline fallback nor supersession extends the wait.
Confirmation evaluates that exact returned snapshot, not a potentially different shared cache entry.

Mid-run recovery: upstream doesn't retry terminal quota errors (`insufficient_quota`, billing,
`subscription_sharing_usage_limit_exceeded`), so they end the run. At `agent_before_settle` the
router confirms the block, omits the failed assistant message with a `context_edit` (pi won't
continue a context ending in an assistant message), and continues once on the next chain model.
Each chain model gets at most one recovery per user prompt. Router quota failover refuses failed
messages containing nonempty text/thinking or any tool call: emitted output cannot be retracted
safely, so retry explicitly instead of switching models. Core's same-model transient retries and
recoverable length/overflow retries are unchanged, including partial attempts core already omitted.
A retryable partial quota error is confirmed and marked before refusing failover; terminal partial
quota errors are refused before confirmation. Prior successful tool turns remain in context and
are not re-executed by router recovery.

Usage collectors: Anthropic OAuth (`/api/oauth/usage`) and ChatGPT Codex (`wham/usage`). API-key
auth has no subscription window and is never blocked. Codex window names follow the reported
`limit_window_seconds`, not their primary/secondary position: some plans expose only a weekly
primary window. Missing durations retain the legacy positional fallback; other durations stay
explicit in seconds rather than being mislabeled as 5h or weekly. Normalized windows carry optional
`durationMs`: Anthropic's known 5h/7d durations (5h only when `five_hour` is reported; an absent, `null` or
`{ utilization: null }` window is dropped, and some plans report only `seven_day`) and Codex's reported duration (legacy positional
fallback when absent). Older or third-party snapshots without durations still score safely. Windows also carry optional `spanSource` (`reported` when the provider stated the span: Anthropic's fixed windows and Codex `limit_window_seconds`; `assumed` for the Codex positional fallback). It is display provenance only, so a footer can avoid calling a guessed window 5h or weekly; scoring, admission and blocking never read it.

Surfaces:

- `subscription_usage` tool: windows plus active blocks. Usage buckets are also added to the system prompt as a `subscription_usage` section. Its guidance names the tool only when the session can call it or discover it through `search_tools` (deferred: discover it first)
- Child sessions share the parent's model runtime and re-register `router/*` into it, so one activation's route serves every session on that runtime. Routing reads only the model registry, never that activation's extension ctx, so it survives the disposal of whichever child loaded last
- `router:decision` entries go to the requesting session through `ctx.appendEntry` when core's `route` context carries one (core with request-owned routing), and are never written through a possibly disposed registrant. Older cores and raw `ModelRuntime` calls carry no requester identity: entries then go to the session that last registered the route and are dropped once that session is disposed
- `router:decision` session entries: one per profile's first scored pick in a session and each later change of chosen model, not every route. This slows growth but is not a hard bound: entries are never pruned, flapping between models and every session restart still append (profile, reason, chosen model, each candidate's score, limiting window, stale flag and data age, ineligible entries). Sticky continuations and repeat picks of the same model are not persisted; status still lists the last five. Read them from the session file to prove why a model was picked
- `/router resets [refresh]`: cached provider schedule view, or explicit bounded read-only refresh. Details and the free-reset capability boundary are below.
- `/router [status|refresh|reset]`: cached-only fresh-dispatch forecast, explicit refresh, or clear all LOCAL confirmed blocks. `reset` does not reset provider quota, redeem a grant, or modify usage counters. Status explains each eligible candidate's score and limiting window, unlimited quota, or fallback reason, plus ineligible entries. Status also lists the last five routing decisions of the current session (of the process, on a core without request-owned routing). The forecast uses chain-order ties without a session incumbent, like admission; an existing balanced conversation additionally applies its previous-model hysteresis/stickiness
- `pi.events` RPC with the pi-subagents envelope (`{ requestId, ... }`, reply on `<channel>:reply:<requestId>` as `{ success, data | error }`):
  - `router:rpc:admit` `{ model }` -> `{ ok, resolvedModel?, resetAt?, wait? }` (`wait`, only when refused: the caller may park until `resetAt`, see `exhaustionPolicy`; a physical model uses the default `wait` policy). Unknown models are admitted. A `router/*` profile is refused only when a quota block leaves no entry eligible; a chain unusable for config or credential reasons is admitted so the child reports the real cause. Before the first `session_start`, everything is admitted
  - `router:rpc:usage` `{ refresh?: boolean }` -> `{ snapshots, blocks }`. Omitted refresh is cached-only. `refresh: true` reads both collected providers through the ordinary five-minute cache, shared in-flight requests, endpoint timeout and failure backoff; it is not a forced refresh. Before session start it remains cached-only. The personal TUI footer uses this RPC once a minute to show provider-wide remaining quota for both subscriptions, independent of the selected model

Usage and block state is process-global, so in-process subagent sessions share it. A newer
confirmation read supersedes older in-flight reads for cache and backoff writes, even when the older
read finishes last. Superseded callers only follow later owners, so no cyclic wait is possible;
each caller waits at most 20 seconds total, even across repeated supersessions. Cancelled callers
detach without aborting shared reads; pre-cancelled requests return cancellation even with a usable
cache, and neither read credentials nor consume the manual refresh allowance. An initiated manual
refresh consumes its allowance even if later superseded or cancelled. Unsupported collector names never
resolve credentials. Out-of-range reset timestamps normalize to an unknown reset.

Core owns OAuth acquisition, refresh and persistence. The router bounds its wait for credential
lookup to 10 seconds, then reports a sanitized error and backs off; it cannot cancel core's lookup.
The subsequent usage HTTP request has its own 10-second timeout. No token or response body appears
in usage errors. These bounds do not prove live OAuth refresh or revocation behavior.

## Reset schedules and free Codex resets

`/router resets` opens cached schedules without a network read. Each provider shows last checked
local date/time, IANA timezone, UTC offset and UTC instant. Windows retain last-known usage,
provider/family applicability, reported versus assumed duration and scheduled reset with relative
time. Expired snapshots stay visibly stale. A passed reset says **needs verification**, never
fabricated replenishment. Missing schedules, unavailable credentials and request failures stay
unknown/unavailable/error, not zero usage. Snapshot freshness does not verify an elapsed reset.

In the native Pi screen, `j`/`k`, arrows and Page Up/Down scroll wrapped text; `q`/Escape closes.
`r` explicitly refreshes usage, with Escape cancelling that caller's wait. Shared reads may still
complete into the cache. `/router resets refresh` also works in non-TUI modes, which emit a
non-triggering transcript message rather than opening a custom screen. Refresh uses the existing
per-provider once/minute manual allowance, shared in-flight reads, 10s credential/10s HTTP deadlines
and failure backoff. Closing the cached screen does not consume the refresh allowance.

Scheduled replenishment is not a banked grant, paid instant reset, extra usage billing, or the
local block-clear command. `/router resets codex` explicitly lists banked FREE reset offers through
the documented first-party app-server. It requires **Codex 0.167.2** on `PATH`; other versions,
missing methods, unsupported external auth and invalid response shapes fail explicitly, with no
guessed command, private HTTP fallback or terminal scraping. The version probe expects exactly
`codex-cli 0.167.2`, matching the pinned `codex-cli` crate's Clap version surface. No client is
installed/upgraded here.
The default cached schedule screen still performs no grant read. Unknown balance/detail fields are
not verified zero, ineligibility or unlimited expiry. Usage credit balances are not reset grants.

Offer reads coalesce and are limited to once/minute/Pi principal-workspace context within the shared router process;
failures back off for that minute and retain visibly stale prior offers. The returned count is
authoritative even when details are capped. Opaque grant/account IDs and arbitrary provider
strings are not rendered; the view shows reported status and grant/expiry times. Per-grant window
applicability and history remain explicitly unreported when the API supplies none. Missing/expired
expiry, unknown reset type/status, zero/unknown balance and unverified main-quota eligibility do
not enable a fresh consume. The provider is the final eligibility authority.

With UI support, select a FREE grant, then separately confirm the current Pi account/workspace,
main quota, one-grant consumption and expiry. The adapter revalidates identity, grant terms and
live eligibility after confirmation. Print/JSON output lists offers without exposing redemption;
RPC supports the same explicit selection/confirmation dialogs, never a model-callable consume tool.
There are no paid purchase, extra-usage enablement or automatic-redemption paths. Embedded usage
adapters must support targeted `invalidate`; otherwise redemption is explicitly disabled while
read-only listing remains usable. Restart Pi after package updates to replace old process-global
usage/controller instances.

Account binding uses Pi's existing Codex OAuth credential owner, including refresh. A dedicated
`codex app-server --listen stdio://` process receives the documented experimental
`chatgptAuthTokens` login after initialization opts into `experimentalApi`. Its home, Codex home
and working directory are a private empty temporary directory, so neither a separate CLI login
nor project Codex configuration is inherited. Tokens travel only over private stdio, not argv,
logs, transcript messages or the journal. The JWT subject and workspace must remain identical
through token rotation; optional user metadata is not substituted for a missing subject. Changes
abort the operation. This is not independent JWT signature
verification or an executable-attestation claim: Pi owns credentials, the provider verifies them,
and the user-installed first-party client is trusted. Credential waits are bounded to 10s, RPCs
to 25s, and client version checks to 3s. Stderr is discarded. Cleanup escalates to SIGKILL after
1s and bounds exit confirmation to 3s; unconfirmed exit retains private temporary state.

A versioned append-only ledger under `<agentDir>/router-codex-resets/<workspace-digest>/` stores
only identity/workspace digests, the logical attempt UUID, opaque selected grant ID, creation/expiry
times and known outcome.
Directories/files are `0700`/`0600`; insecure, symlinked, oversized or corrupt state fails closed.
The [schema](schemas/codex-reset-journal.schema.json) matches runtime validation. Fully written
records are fsynced and exclusively published before dispatch. Concurrent fresh attempts compete
for the same workspace sequence, so only one wins; in-process active attempts are also shared
across reloads. Switching principals in the same workspace cannot bypass unresolved work, and
reconciliation refuses a different principal until the original account context is restored.
These local records are private operational state, not public debugging artifacts. Known successful
receipts suppress repeat use of a grant even if the provider's offer response has not caught up;
the provider's reported count is displayed, never locally decremented or fabricated.

Publication itself establishes the unresolved barrier, even if this process later fails identity
validation, is cancelled before its own dispatch, encounters an error/missing method or crashes.
Another process may already be reconciling that published claim. A process-local observation cannot
prove global non-dispatch. `noCredit` and `nothingToReset` remain distinct reported refusals, but
also retain the barrier: neither fences another same-key request that may still be in flight.
The command reports that refusal separately from the UNKNOWN global outcome and requires
**Reconcile SAME**, never claiming that no grant was consumed.
Timeout, lost completion or reload likewise leaves that original attempt unresolved, blocking new grants. Inspection never replays it. A separate **Reconcile SAME** action
requires another explicit confirmation, reads current offers/account state, and uses the original
grant and provider idempotency key. It may consume that original FREE grant if the first request
never completed; it cannot select another grant or UUID. Concurrent idempotent successes are
equivalent. Only `reset`/`alreadyRedeemed` may publish a terminal receipt. There is no time-based
expiry, stale-lock reclamation or automatic replay. This intentionally favors a retained barrier
over silently spending another grant. If reconciliation keeps refusing or the client lacks the
method, use the official UI; Pi does not invent a safe release from those observations.
Legacy `notDispatched`/refusal receipts are treated as unresolved, not trusted as safe release.
A following legacy attempt makes that journal inconsistent and fails closed; an immutable legacy
receipt is never overwritten to manufacture certainty. Use the official UI for that quarantined state.
Unknown or conflicting outcomes remain blocked rather than being guessed successful or retried
automatically. Do not delete the ledger to bypass unresolved work.

Confirmed success invalidates only Codex usage evidence and pre-reset read ownership, then reads
banked offers and authoritative quota separately, even if saving the known outcome receipt fails.
The unresolved attempt remains retained, but a local persistence failure cannot keep pre-reset
quota evidence authoritative. A failed/cancelled refresh does not erase a
confirmed redemption, justify another grant, invent new allowance or zero counters. Only fresh,
exact window/provider/family evidence can reconcile a corresponding confirmed block; unrelated
blocks stay untouched. Late pre-reset reads cannot re-confirm old exhaustion after invalidation.
The command emits no wake/resume event: parked work retains ordinary re-admission and goals/loops
still require explicit resume.

Official handoff: in Codex CLI, `/usage` -> **Redeem reset**. If absent, use desktop
**Settings > Usage & billing** or web **Usage settings**. Verify account/workspace, covered
allowances and expiry there before confirming a FREE banked reset. **Buy an instant reset** is a
separate paid flow, excluded here. If completion is uncertain, inspect Usage/history before trying
again; do not spend another grant to test success. Then refresh schedules in Pi. This remains the
handoff for unavailable clients/capabilities and unreported grant terms. `/router reset` remains a
LOCAL block-clear command, not server quota or grant consumption.

### Provider contract evidence and staged design

Research checked 2026-11-12, without authenticated requests, terminal scraping or provider mutations.
Executable adapter proofs use synthetic clients, not an authenticated installed Codex:

- The official [reset guide](https://help.openai.com/en/articles/20001498-how-resets-work-in-codex)
  documents discretionary free banked grants, grant-specific expiry, covered main allowances,
  eligibility, the CLI handoff and 30-day banked history. Product UI alone is not API evidence.
- OpenAI Codex release `rust-v0.167.2`, published 2026-11-11, resolves through annotated tag
  `08a3b12b3298577534a28b62ed976acf8de66eda` to commit
  `ce21072c90d32c40af7a55b60b2fb35c84a43a6a`. Its first-party protocol
  [source](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/app-server-protocol/src/protocol/common.rs)
  declares `account/rateLimits/read` and `account/rateLimitResetCredit/consume` without an
  experimental method annotation. The version-pinned
  [processor](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/app-server/src/request_processors/account_processor/rate_limit_resets.rs)
  requires Codex-backed authentication, a nonempty idempotency key and an optional nonempty grant ID.
  The pinned [CLI](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/cli/src/main.rs)
  uses Clap's version surface from its
  [crate](https://github.com/openai/codex/blob/ce21072c90d32c40af7a55b60b2fb35c84a43a6a/codex-rs/cli/Cargo.toml), `codex-cli`.
- Crucially, the public [app-server docs](https://developers.openai.com/codex/app-server/),
  sections **Rate limits (ChatGPT)** and **Earned rate-limit resets (ChatGPT)**, independently
  document this JSON-RPC contract. This is a supported first-party client surface, not permission
  to automate its private backend. `rateLimitResetCredits: null` means unknown; `credits: null`
  means count-only; a fetched empty array is distinct. `availableCount` is authoritative because
  details can be capped. Detail rows report ID, reset type, status, grant/expiry times and optional
  title/description, not necessarily full history or quota applicability.
- The documented consume call uses one UUID per logical attempt, reused only for that attempt.
  `reset` and `alreadyRedeemed` are success; `nothingToReset` and `noCredit` are distinct refusals.
  Refresh `account/rateLimits/read` afterward; never derive new windows from the consume response.
- No standalone noninteractive `codex reset` command was verified. No direct provider HTTP
  listing/redemption contract was established. Anthropic
  [extra usage](https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans)
  is paid consumption, not a free reset. Paid weekly resets are a
  [separate product](https://help.openai.com/en/articles/20001507-paid-weekly-work-and-codex-rate-limit-resets).

Stage 1 is the router-owned cached schedule interpreter/native view. Stage 2 adds the isolated,
account-bound first-party adapter, actual offer listing and explicitly confirmed FREE consumption
above, without SessionKit or a universal redemption framework. `test/scenarios/codex-resets.test.ts`
executes the real Pi command and adapter against a real credential-free faux app-server process:
a backend-completed/lost-response attempt survives reload, reconciles with the original key, and
records exactly one spend. Unit/boundary tests cover zero/expired/ineligible/unknown grants,
version/capability/auth mismatches, private-state validation, cancellation, concurrent claims,
pre-reset read races, uncertain outcomes and success followed by refresh/receipt failure.
`test/codex-cross-process.test.ts` uses two actual isolated controller processes, IPC barriers and
shared real journal files. It pauses the publisher after claim publication, dispatches reconciliation
from the other process, then exercises identity/cancel/error/missing-method/refusal/crash outcomes
and response loss. Fresh grants remain blocked until explicit original-key success; reload never
replays a consume. These tests run under both Node and Bun, without provider network traffic.
No authenticated LIVE redemption or paid call is part of development tests; live provider behavior
and runtime client installation are NOT RUN by these synthetic proofs. Paid purchase, extra-usage
enablement and automatic redemption remain excluded.

Development:

```sh
# From the monorepo root:
make install
npm run check --workspace @nredd/pi-subscription-router  # biome, tsc, vitest, bun scenarios
```

Journal permission tests explicitly set and verify insecure fixture modes after creation, so a restrictive
`0077` umask does not turn the rejection case into valid private state. Production directory checks still
reject group/other access and symlinks without repairing existing state.

The `lint` and `format` commands check that their configured `src/` and `test/` paths exist before invoking Biome. This avoids Biome's successful mixed valid/missing-path result hiding a stale path.

`test/scenarios/` covers terminal/retry/unconfirmed recovery, partial-stream refusal, cancellation,
bounded retries, direct `subscription_usage` execution and all six balanced cases through the real
router factory and core session harness, under Vitest and Bun. Policy tests add pre-calculus golden
receipts (including full status, numeric/timing boundaries, confirmation races, cancellation and partial
output), a Git-blob-pinned merge-base oracle with 4,096 seeded differential cases, deterministic
exhaustive properties, offline normalized replay, strict failback, raw-remaining
family caps, confirmed recovery and shared-runtime isolation.

`createSubscriptionRouter({ config, usage, tracker?, now?, codexResets? })` embeds an isolated router with explicit dependencies; the default export still loads agent config and shares usage/blocks process-wide. Scenarios inject a credential-free cache and quota clock; core retries use `baseDelayMs: 0`.

`integration/inprocess/router-admission.test.ts` covers `wait`, `fail` and `capped` with the real router/subagents factories on one fake clock under Vitest and Bun. The optional-router absence case is `packages/subagents/test/session-scenarios.test.ts` / `absent admission RPC admits physical child`. No installed Pi, owner checkout or `PI_SUBAGENTS_DIR` is needed.

## Routing policies v1

`policy` opts a profile into versioned semantics. It is mutually exclusive with `strategy`.
Omitting both still means legacy `ordered`; existing profiles are never migrated. The shipped
[JSON Schema](schemas/subscription-router.schema.json) describes the closed policy union.
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
  unknown, not free capacity. The shipped `lexicographic-example` uses `binding`, so both providers
  can compete and its margin can actually switch between them. Prefer binding across providers:
  Codex never reports Anthropic's `seven_day_fable`, so ranking only that name would demote Codex
  to unknown rather than balance the subscriptions.

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

## Quota fairness contract

This specifies legacy `balanced`, not a scheduler. Versioned opt-in policies are documented
[here](#routing-policies-v1): `remaining-balanced` maximizes binding raw remaining instead of reset pace,
with zero margin and continuation-only stickiness by default; `strict-priority` intentionally
provides no balancing guarantee. Legacy defaults and behavior remain unchanged.
Legacy fairness means balancing **normalized quota headroom per window, adjusted for reset pace**,
not equal requests, tokens, dollars, latency or local session usage. Provider percentages are account-wide observations:
other Pi sessions, other clients and outside use contribute to them.

### Actual policy

[`selection.ts`](src/selection.ts) scores fresh available snapshots, and recently
expired ones at reduced trust (see "Stale grace" below). For each
applicable active finite window `w`:

```text
r_w = 1 - min(usedPercent_w, 100) / 100
f_w = clamp((resetAt_w - now) / durationMs_w, 0.05, 1)
s_w = r_w / f_w
s_model = min_w s_w
```

Negative/nonfinite utilization and passed finite resets are ignored. Missing or invalid
timing gives `f_w = 1`. Model-scoped windows count only for matching families. A fresh
unlimited snapshot ranks above every measured score; absent, error, unavailable,
inapplicable or long-expired data is fallback, below every measured score. Chain order breaks ties.
A positive credit balance alone is not unlimited.

#### Stale grace

A snapshot older than the 5 minute cache TTL is `stale`. Background refresh
(`warm()`) is never awaited and routing never reads the network, so a fresh child's
first route can run on expired data. Treating that as fallback ranked every
just-expired provider below any fresh measured one, i.e. it always favoured whichever
chain entry happened to have fresh data (usually `chain[0]`).

Now a stale or TTL-expired snapshot whose `retrievedAt` is at most `STALE_GRACE_MS`
(15 minutes, `selection.ts`) old scores as measured, normally, with `stale: <age>`
attached to the score. Reduced trust is structural, not numeric: it is flagged in
`/router status` and the decision log, it is never unlimited (unlimited requires fresh
data), and failed reads (`error`/`unavailable`) are still fallback. No discount is
applied because any factor would re-introduce a fixed bias for or against a provider.
Past the grace window the snapshot is fallback again. Exhaustion blocking is unchanged
(`UsageService.decisionFor`). Note the G1-G4 proofs assume fresh telemetry; stale
scores are older observations of the same account-wide percentages.

#### Decision log

Each scored pick (not sticky continuations or same-model retries) is recorded in memory;
a profile's first pick per session and each change of chosen model also append a
`router:decision` custom session entry. Repeats of the same model are skipped, which
reduces growth but is not a hard bound: entries are never pruned, and flapping between
models or restarting a session appends again. A
`RouteDecision` (`router.ts`) holds time, profile,
strategy, reason, chosen `provider/id`, every candidate's score (kind, score, limiting
window, `stale` age) with snapshot age, and ineligible entries with reasons. `/router
status` prints the last five of this process. The entries are the durable record for
proving why a pick happened.

[`Router.pick`](src/router.ts) first filters unresolved models, missing credentials,
tracker blocks and cached exhausted applicable windows. Scores never deny admission.
[`UsageService.decisionFor`](src/usage.ts) retains stale exhausted windows with a
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

### Conditional guarantees and proofs

These statements deliberately distinguish selection-time guarantees from accounting
models. The deterministic simulator calls the real `Router.route`, `Router.pick`,
`ExhaustionTracker` and `UsageService.decisionFor`; quota observations, clock and
physical resolution are fixtures. `CachedUsage.peek` is also substituted: it returns
mutable snapshots without production `peek`'s expiry-to-stale conversion (the scorer
itself handles both forms). These tests
therefore exercise real dispatch/eligibility and scoring, not the production cache
lifecycle; usage tests cover that lifecycle separately. The reset test refreshes only
snapshot expiry to isolate passed-window scoring. No second routing algorithm is used.

#### G1: best eligible candidate, without affinity

For balanced selection with no incumbent, the result has maximal tier and, within the
measured tier, maximal score among eligible candidates. Among equal maxima it is the
first chain entry. If no entries are eligible, selection fails.

Proof: the scan starts at the first candidate and replaces it only on strict improvement.
After each prefix its retained candidate is the first maximum of that prefix. Eligibility
filtering preserves order. This is a local selection property, not a throughput theorem.
`fairness.test.ts` exhaustively checks all `17^3 = 4913` fresh utilization triples on a
sixteenth grid, including exhausted entries and the all-blocked case. Existing
`selection.test.ts` covers tiers and floating-point ties.

#### G2: symmetric independent fresh prompts

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

#### G3: incumbent hysteresis is a band, not alternation

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

#### G4: no anti-herding or reset-survival guarantee

No aggregate allocation bound follows from G1 across independent processes or delayed
telemetry. Sixteen clients with the same fresh tied snapshot all choose the first
account: all sixteen dispatches can target capacity eight before any observation changes.
Even a single router with a lagging snapshot sends twelve synthetic units to capacity
eight. Refresh redirects the *next* dispatch; it cannot retract previous work.

These are deterministic counterexamples, not stochastic performance estimates. The
multi-client fixture uses distinct Router instances with identical snapshots, no real
network or shared reservation. It models simultaneous admission, not provider acceptance
of every over-capacity request. The provider may reject excess requests.

### Exclusions and non-guarantees

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

### Evidence and next decisions

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
