# pi-subscription-router

Publishable to npm as `@nredd/pi-subscription-router` (`publishConfig.access: public`), version `0.3.0`; each publication is recorded in `releases/`.
Use the [monorepo development commands](https://github.com/nredd/pi-harness/blob/main/README.md). The Git install and installed-Pi scenarios
below describe the legacy deployment, not installation or candidate verification of this package.

## Standalone use

The packed tarball is self-contained: Pi host modules (`@earendil-works/pi-*`, `typebox`) are `*` peers supplied by Pi, there are no runtime dependencies and no sibling plugin is required. Verified by installing the tarball alone and running it in exact stock Pi 1.3.0 (see the repository's `docs/package-contracts.md`). Optional fork integrations (subagents, Plan mode) are absent in that setup; the exercised behavior does not need them.

`router/<profile>` virtual models for pi (>= 0.99) that route across included subscription quota.
Each profile has a chain of physical models and an optional routing strategy. Ordered routing
(default) picks the first eligible model. Balanced routing spends fresh cached quota according
to remaining capacity and reset timing, without adding network reads or changing quota blocks.

Install:

```sh
pi install git:github.com/nredd/pi-subscription-router@v0.3.0
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

- `strategy` (`"ordered"` default, or `"balanced"`) selects chain-order routing or reset-aware balancing. Opt in per profile, e.g. `"strategy": "balanced"`; arbitrary chain lengths and providers work, unknown collectors remain usable fallbacks
- `exhaustionPolicy` (`"wait"` default, or `"fail"`) says what a dispatcher that can wait (pi-subagents background jobs) does when every quota-eligible entry is exhausted: park until the earliest reset, or fail now. `maxWaitMinutes` (default unlimited) caps how far ahead a reset may be waited for, and a reset that is unknown always fails. Foreground requests cannot wait and fail either way
- `thinking` pins that entry's level. Without it the selected level passes through
- With `enabledModels` / scoped models, add `router/<profile>` there too

Routing:

- Ordered `user`, `direct`: first eligible entry, unchanged
- Balanced `user`: highest-ranked eligible entry, with incumbent hysteresis below
- Balanced `direct`: stays on the eligible previous model when supplied, otherwise uses the balanced pick
- `continuation`: stays on the model that last answered, unless unavailable or quota-blocked; balancing applies only when it must leave
- `retry` (upstream auto-retry, e.g. a 429): refreshes usage. Confirmed -> mark and advance. Otherwise retry the same model
- All blocked: the request fails with the earliest known reset

Balanced scoring:

- For each applicable provider/family window, `remaining = 1 - usedPercent / 100`, `timeLeft = clamp((resetAt - now) / durationMs, 0.05, 1)`, `score = remaining / timeLeft`. The tightest (minimum-score) window limits the model. Past/equal reset windows are ignored; missing usable reset/duration uses `timeLeft = 1`
- Fresh unlimited ranks above fresh measured, then missing/stale/failed/empty or non-applicable usage. Ties retain chain order. Stale unlimited is still fallback, not unlimited
- New prompts keep an eligible measured incumbent unless the challenger is *strictly* more than 20% better (floating-point normalization and boundary roundoff are treated as a tie, including near-exhausted windows). A measured challenger promotes an unmeasured incumbent; if all are unmeasured, the incumbent stays. Fresh unlimited promotes measured and remains sticky
- The same pure scoring and cached selection feed routing, recovery, admission and status. Scores never block quota, fetch data, or enter the system prompt. Adding a provider needs only a normalized collector and chain entry, not another algorithm

Eligibility never hits the network. An entry is skipped when a confirmed block covers it, when
cached usage already shows its window exhausted, or when it has no credentials. Stale or failed
usage fails open, except stale data whose known reset is still ahead.

Blocks are per `(provider, family)`: the Anthropic `seven_day_sonnet` window blocks Sonnet and
leaves Opus eligible. A block lasts until the reset the provider reported. Without one it backs off
5 minutes, doubling up to 60.

Confirmation needs live data read after the failure: a cached or in-flight read from before the
error's timestamp doesn't count, while simultaneous failures still share one request. A failed or
backed-off read confirms nothing.

Mid-run recovery: upstream doesn't retry terminal quota errors (`insufficient_quota`, billing,
`subscription_sharing_usage_limit_exceeded`), so they end the run. At `agent_before_settle` the
router confirms the block, omits the failed assistant message with a `context_edit` (pi won't
continue a context ending in an assistant message), and continues once on the next chain model.
Each chain model gets at most one recovery per user prompt.

Usage collectors: Anthropic OAuth (`/api/oauth/usage`) and ChatGPT Codex (`wham/usage`). API-key
auth has no subscription window and is never blocked. Codex window names follow the reported
`limit_window_seconds`, not their primary/secondary position: some plans expose only a weekly
primary window. Missing durations retain the legacy positional fallback; other durations stay
explicit in seconds rather than being mislabeled as 5h or weekly. Normalized windows carry optional
`durationMs`: Anthropic's known 5h/7d durations and Codex's reported duration (legacy positional
fallback when absent). Older or third-party snapshots without durations still score safely.

Surfaces:

- `subscription_usage` tool: windows plus active blocks. Usage buckets are also added to the system prompt as a `subscription_usage` section
- `/router [status|refresh|reset]`: cached-only fresh-dispatch forecast, explicit refresh, or clear all blocks. Status explains each eligible candidate's score and limiting window, unlimited quota, or fallback reason, plus ineligible entries. The forecast uses chain-order ties without a session incumbent, like admission; an existing balanced conversation additionally applies its previous-model hysteresis/stickiness
- `pi.events` RPC with the pi-subagents envelope (`{ requestId, ... }`, reply on `<channel>:reply:<requestId>` as `{ success, data | error }`):
  - `router:rpc:admit` `{ model }` -> `{ ok, resolvedModel?, resetAt?, wait? }` (`wait`, only when refused: the caller may park until `resetAt`, see `exhaustionPolicy`; a physical model uses the default `wait` policy). Unknown models are admitted. A `router/*` profile is refused only when a quota block leaves no entry eligible; a chain unusable for config or credential reasons is admitted so the child reports the real cause. Before the first `session_start`, everything is admitted
  - `router:rpc:usage` `{ refresh?: boolean }` -> `{ snapshots, blocks }`. Omitted refresh is cached-only. `refresh: true` reads both collected providers through the ordinary five-minute cache, shared in-flight requests, endpoint timeout and failure backoff; it is not a forced refresh. Before session start it remains cached-only. The personal TUI footer uses this RPC once a minute to show provider-wide remaining quota for both subscriptions, independent of the selected model

Usage and block state is process-global, so in-process subagent sessions share it.

Development:

```sh
# From the monorepo root:
make install
npm run check --workspace @nredd/pi-subscription-router  # biome, tsc, vitest
cd packages/subscription-router
e2e/run.sh             # every scenario below, asserted; exits non-zero on any FAIL
e2e/run.sh terminal    # faux providers + installed pi: terminal quota error -> settle recovery
e2e/run.sh retry       # 429 -> confirmed on retry -> next chain model
e2e/run.sh unconfirmed # usage disagrees -> error stands, no loop
e2e/run.sh wait        # pi-subagents background dispatch, all exhausted, policy wait -> parked
e2e/run.sh fail        # same, policy fail -> refused, nothing queued
e2e/run.sh capped      # reset beyond maxWaitMinutes -> refused
e2e/run.sh no-router   # enterprise profile, no router loaded -> admitted, child runs
e2e/run.sh balanced-route    # actual pi RPC, three providers -> highest reset-aware score
e2e/run.sh balanced-switch   # multiple user prompts -> 20% boundary stays, then switches
e2e/run.sh balanced-sticky   # quota changes after tool -> continuation stays on incumbent
e2e/run.sh balanced-blocked  # exhausted incumbent after tool -> eligible balanced fallback
e2e/run.sh balanced-fallback # stale/missing data -> fresh measured provider
e2e/run.sh balanced-unmeasured # measured quota exhausted -> usable unmeasured fallback
```

The last four load pi-subagents from `$PI_SUBAGENTS_DIR` (default `~/code/pi-subagents`).
