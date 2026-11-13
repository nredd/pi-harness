# Premature-handback diagnostics

Issue [#798](https://github.com/nredd/pi-harness/issues/798) distinguishes a model ending its
response from the user's work being complete. Three targeted private-session examples were
nonempty, tool-free finals (`stop`, raw `completed`). A separate empty response was an error.
No successful empty live completion, dropped live call, or model-specific cause was established.
Route metadata is not independent evidence of the serving backend. No transcripts are fixtures.

## Executable boundaries

Run the offline fixtures, with one worker, from `integration/inprocess`:

```sh
node ../../scripts/run-vitest.ts node provider-settlement.test.ts owned-work-settlement.test.ts settlement-identity.test.ts --maxWorkers=1 --coverage.enabled=false
node ../../scripts/run-vitest.ts bun provider-settlement.test.ts owned-work-settlement.test.ts settlement-identity.test.ts --maxWorkers=1 --coverage.enabled=false
```

`provider-settlement.test.ts` intercepts HTTP before calling the real Responses adapter. It
uses the existing in-process `AgentSession` harness, bridges its public provider-event callback
as `sdk.ts` does, and records only event enums, block kinds, stop/outcome enums, continuation
booleans and pending-message counts. The observer is loaded last; the boundary observation
sees preceding handlers' chained decisions. These are test-local observations, not new runtime
logging or a production extension. Payload, prompt, arguments, error text, model/provider IDs
and paths do not enter the trace. Sentinel assertions check this separation.

The sequence for a normal completed tool-free response is:

```text
response.output_item.done -> response.completed
-> message_end(stop, [text])
-> agent_before_settle(completed, continue=false, pending=0)
-> agent_settled(aborted=false)
```

`completed` is a provider-response status, not a task-completion judgement. `agent_end` alone
is not final settlement: retry, queued input, compaction and extension continuation may follow.
`agent_before_settle` is the actionable boundary; `agent_settled` is notification-only.

| Synthetic provider sequence | `.10` / `.11` release-artifact SDK result |
| --- | --- |
| Nonempty completed text | Successful settlement, one request |
| Genuinely empty completed output | Successful empty settlement; no invented tool |
| Complete tool `output_item.done`, no earlier added/delta events | Tool preserved and executed once; follow-up request |
| Terminal-only text/tool in `response.completed.output` | Output lost; successful empty settlement |
| Text followed by early EOF or failed terminal | Error settlement, not a successful final |
| Added tool without `output_item.done` | Error; no tool execution |

The terminal-only row establishes a **synthetic malformed-stream fail-open defect** in the
shared Responses normalizer, tracked separately in [nredd/pi#45](https://github.com/nredd/pi/issues/45).
It does not establish that a live provider emitted that sequence. The core fix rejects missing
finalized items without reconstructing calls, adding retries or changing continuation policy.
These characterization tests intentionally describe the pinned releases; update their terminal-only
expectations when a separately reviewed core release containing that fix is selected. This PR
changes no Gitlink, package pin or installed runtime.

## Ownership controls

`owned-work-settlement.test.ts` loads the real todo factory, restores synthetic persisted tasks,
and emits the existing lifecycle bus contracts. It does not launch actual workers or monitors;
`monitor-todo-settle.test.ts` separately covers the composed kit-monitor lifecycle.

| Ownership at settlement | Current todo behavior |
| --- | --- |
| Actionable parent-held work, no wake | One reminder, then warning |
| Unlinked monitor, or monitor linked only to another todo | Same reminder; unrelated monitor cannot mask work |
| Unrelated background agent with a completion wake | No held-work reminder; held report is info |
| All actionable work blocked behind a linked monitor | No reminder; info report |
| Explicit wait represented by a linked monitor | No reminder; info report |
| Persisted owner missing after process startup | One reminder; lost-owner warning |
| Failed child owner | Warning, no additional continuation policy |
| Completed child with unfinished parent follow-up | Parent-held reminder; child completion does not complete the todo |
| Merely pending todo, explicit instruction to wait | No reminder |

The session-wide suppression is specifically `hasArmedAgent`, not all monitors. The source's
`unarmedHeld` early return and held-warning downgrade still apply when that agent is unrelated
to an independently actionable local task. This is an explicit current policy, not proof of a
core-loop defect. Changing it requires a decision about task-linked wakes and held/lost/failed
ownership, not a text heuristic or an unbounded continuation loop. The tests do not interpret
"I'll do X" or otherwise infer intent from final prose.

[#292](https://github.com/nredd/pi-harness/issues/292) chose report-only. Later todo source adds
bounded held/plan reminders. This investigation changes neither policy. A legitimate child
handoff of parent-owned critic/CI/merge duties is not parent abandonment, and pending tasks alone
are not a correctness failure.

## Identity and limits

Original harness source: `aafa421d93fabc22b12b8b21a375539216f27ed9`.
Candidate Gitlink: `640d64bcd4da08231232b5c08acd48b88ee1fd45` (`v1.3.0-nredd.11`).
Both release-artifact SDKs passed the same 18 provider/ownership cases under Node and Bun.
The separately installed CLI was still `.10`; its live processes were not reloaded or exercised.

The shared development dependency tree initially contained `.10` although the candidate lockfile
selected `.11`. The isolated candidate install corrected this **test setup**, not production.
`settlement-identity.test.ts` now fails closed on missing/mismatched installed lock receipts and
checks that imports resolve to those exact package entries. It emits only fixed public artifact
URLs, integrity strings and SHA-256 hashes, plus the todo source entry/policy file hashes.
Package version `1.3.0` alone cannot distinguish these fork releases.

Identity-only on-disk comparison (SHA-256):

| Component | Installed / baseline | Candidate |
| --- | --- | --- |
| Release SDK `pi-ai/dist/api/openai-responses-shared.js` | `6ad181b59e100cbd6791ecc83733646586fbe8e6f41d8e0d30844093ae1aa069` | Same |
| Release SDK `pi-coding-agent/dist/core/agent-session.js` | `b8a4393963378f078c97244b39d47b30238a97574857d8b49b3de833e512b2f2` | `3eee30601744d644d57ab22ac8f062e9c36474436f2a11bd92900c04fb8f857d` |
| Todo `plan-hooks.ts` | `962ffa28519b998f5833cc59c200bdcfaf5d0db1570a52c2a89a43991c82bd06` | Same |

Installed todo `index.ts`, `state/agents.ts` and `state/monitors.ts` also matched candidate bytes.
The installed CLI's nested dependency files are not the release-SDK artifacts and have different
hashes; the CLI bundle is not the in-process test target. Neither file equality nor a merged SHA
attests the code already loaded by a historical long-running process. That identity remains
unknown. Do not claim a source fix was activated or these tests exercised the live CLI.

Ordinary session JSONL does not persist raw provider events. Existing private transcripts cannot
prove or refute normalization loss. For a future authorized capture, follow the bounded,
allowlisted projection pattern in `integration/probes/transcript-types.ts`; that existing opt-in
probe is Anthropic-specific, not a Responses settlement recorder. Do not use the raw
`debug-provider` example for public evidence: it retains payloads. No production capture or
observability framework is installed by this investigation.
