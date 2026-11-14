# pi-subscription-router

Published to npm as `@nredd/pi-subscription-router` (public). From `0.4.0`, each version is cut by the monorepo `Publish` workflow from a signed `@nredd/pi-subscription-router@<version>` tag, with npm provenance and a GitHub release carrying the tarball, checksums and manifest (`docs/releases.md`); earlier versions were published manually without provenance. `0.4.0` adds `createSubscriptionRouter(options)` (explicit `config` and `usage`, injectable `tracker` and `now`; the default export is unchanged).
Use the [monorepo development commands](https://github.com/nredd/pi-harness/blob/main/README.md). The Git install
below describes legacy deployment, not installation or candidate verification of this package.

## Standalone use

The packed tarball is self-contained: Pi host modules (`@earendil-works/pi-*`, `typebox`) are `*` peers supplied by Pi, there are no runtime dependencies and no sibling plugin is required. Verified by installing the tarball alone and running it in exact stock Pi 1.3.0 (see the repository's `docs/package-contracts.md`). Optional fork integrations (subagents, Plan mode) are absent in that setup; the exercised behavior does not need them.

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
[here](docs/policies.md); opt-in examples are [here](examples/policies.json). Existing examples and
legacy strategies keep their behavior and serialized decisions.

Routing (legacy strategies):

- Ordered `user`, `direct`: first eligible entry, unchanged
- Balanced `user`: highest-ranked eligible entry, with incumbent hysteresis below
- Balanced `direct`: stays on the eligible previous model when supplied, otherwise uses the balanced pick
- `continuation`: stays on the model that last answered, unless unavailable or quota-blocked; balancing applies only when it must leave
- `retry` (upstream auto-retry, e.g. a 429): refreshes usage. Confirmed -> mark and advance. Otherwise retry the same model
- All blocked: the request fails with the earliest known reset

Balanced scoring (conditional fairness guarantees and exclusions [here](https://github.com/nredd/pi-harness/blob/main/packages/subscription-router/docs/fairness.md)):

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
family caps, confirmed recovery and shared-runtime isolation. The coverage/ownership matrix and
live-smoke proposal are [here](https://github.com/nredd/pi-harness/blob/main/packages/subscription-router/docs/hardening.md).

`createSubscriptionRouter({ config, usage, tracker?, now?, codexResets? })` embeds an isolated router with explicit dependencies; the default export still loads agent config and shares usage/blocks process-wide. Scenarios inject a credential-free cache and quota clock; core retries use `baseDelayMs: 0`.

`integration/inprocess/router-admission.test.ts` covers `wait`, `fail` and `capped` with the real router/subagents factories on one fake clock under Vitest and Bun. The optional-router absence case is `packages/subagents/test/session-scenarios.test.ts` / `absent admission RPC admits physical child`. All 13 former shell cases have native receipts in `docs/verification-rebuild.md`; the shell runner and its unused faux helpers are deleted. No installed Pi, owner checkout or `PI_SUBAGENTS_DIR` is needed.
