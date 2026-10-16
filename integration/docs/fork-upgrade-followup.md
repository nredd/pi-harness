# Fork upgrade follow-up and transcript classification investigation

## Scope

Continue upgrading to released upstream bases, retaining only demonstrated fork behavior.
`pi-plan-mode` and `rpiv-todo` are owned by another session: do not edit, rebase, tag,
or change their pins here. Coordinate before any broad chezmoi apply that could affect them.

## Current release evidence

- Core `v1.3.0-nredd.1` is published and installed; upstream `v1.3.0` is the latest
  released core tag observed on 2026-10-16. This does not mean tracking unreleased `main`.
- `/tmp/verify5.log`: `make verify` on the installed release exited 0, with 131
  integration/static tests passed, one skipped, and 122 TUI/benchmark tests passed.
- The full core `./test.sh` gate now passes (exit 0 in
  `/tmp/pi-core-gate-followup.log`). Built `packages/env` with its documented
  `npm run build:daemon` prerequisite first. Coding-agent: 2,798 tests passed;
  env: 85 passed, two intentionally skipped (platform-specific filenames and
  external SSH). The earlier six failures were import-time missing-daemon checks.
- The 1.3.0 release was tagged before the required pre-release harness/review steps.
  The later green gates do not retroactively establish that procedure was followed.
- Retrospective two-axis review ran on `v1.3.0...8782eb6f0`: Spec reported no
  findings. Standards flagged the single-use `turnRule` helper for inlining,
  duplicated disclosure mouse handling (judgement), and changelog entries on a
  non-main branch. The last conflicts with the explicit fork runbook requirement
  to retain entries under `[Unreleased]`; the runbook governs fork releases.
  Resolve the helper finding and re-review before the next core tag; no style-only
  core release was cut as part of the classification investigation.

## Incident: visible commentary stored as thinking

Evidence from the existing session, without copying private transcripts or signatures:

- The affected assistant entry reports `anthropic/claude-sonnet-5-5`, API `anthropic-messages`, stop reason `toolUse`.
- Saved content is `thinking` (230 characters), `thinking` (276 characters),
  `toolCall`. The second block contains the acknowledgement intended for the user.
  There is no `text` block. Both thinking blocks have signature fields; this alone
  does not authenticate their classification or prove where it originated.
- The existing parent process loaded a native module from the
  `1.0.0-nredd.7` Cellar tree. Upgrading the CLI did not restart this process.
  Do not attribute the incident to the installed 1.3.0 runtime without a fresh run.
- The original raw SSE trace was not captured. Session JSON cannot distinguish
  provider misclassification from an earlier adapter/extension transformation.

Offline boundary check:

```sh
node probes/anthropic-block-types.mjs /path/to/built/pi-ai
```

The probe sends identical synthetic acknowledgement wording as either a wire `text`
or wire `thinking` block, following thinking and preceding a tool call. It asserts
raw-event types, normalized types, order, and content preservation. It never executes
tools or contacts a provider. No arguments fails with exit 2.

Observed results on both installed 1.0.0 pi-ai and the 1.3.0 fork build:

```text
wire text -> normalized text: PASS
wire thinking -> normalized thinking: PASS
```

This disproves a simple deterministic misclassification of text after thinking for
these inputs. It is NOT a replay of the incident or proof that the bug is fixed.

Read-only tracing found no Anthropic response-classification patch in our core diff.
`pi-claude-auth` changes outbound request formatting; that can affect model behavior,
but is not itself evidence of response relabelling. The router selects physical models
and handles quota recovery. These findings narrow the search, not establish a cause.

## Live boundary checks

A fresh in-memory session using the old `1.0.0-nredd.7` runtime, Sonnet 5.5,
medium thinking, and the installed `pi-claude-auth` request formatter was tested
with only a terminating synthetic `noop` tool. No credentials were copied.

First attempt explicitly requested a visible acknowledgement, then `noop`:

```text
raw: text@0 -> tool_use@1
message_end: [text, toolCall]
acknowledgement marker in raw text: true; raw thinking: false
acknowledgement marker in normalized text: true; normalized thinking: false
noop executions: 1
```

The bug did not reproduce. This narrow prompt also produced no thinking blocks,
so it cannot establish behavior under the original long conversation's conditions.
The sanitized local evidence is in
`~/code/pi-diagnostics/live-block-classification-evidence.json`; it contains types,
indexes, match booleans, and no provider contents, signatures, or credentials.

Second attempt used the original scope restriction (another session owns plan mode
and todos), requested an acknowledgement followed by `noop`, and did not explicitly
say to make the acknowledgement visible. It also returned raw `text@0 -> tool_use@1`
and normalized `[text, toolCall]`, with the `plan` substring present only in text.
It executed `noop` once and exited 0 under a 120-second deadline. Evidence is in
`~/code/pi-diagnostics/live-block-classification-evidence-2.json`.
Neither live attempt reproduced the fault; neither emitted a thinking block.
Stop the bounded probe here. A capture from a recurrence in a long-running session
is still needed before assigning cause or proposing a classification patch.

## Capture the next recurrence

The opt-in extension `probes/transcript-types.ts` is ready but is NOT installed or
armed in existing sessions. Start a fresh process and resume the affected session:

```sh
PI_TRANSCRIPT_TYPES_DIR="$HOME/.pi/diagnostics/transcript-types" \
  pi -e "$HOME/code/pi-harness-e2e/probes/transcript-types.ts" --resume
```

Each session creates a new exclusive `0600` JSONL file in that directory. New
directories are created with mode `0700`. It records only fixed stage/type labels,
local timestamps/PID, integer block indexes, and a local raw-message ordinal.
No prompts, text, thinking, signatures, tool names/arguments, headers, model names,
or credentials are written. Unknown provider labels become `unknown`.

Capture boundaries are parsed `provider_stream_event` (not HTTP bytes), normalized
`message_update`, `message_end` at this extension's position in handler order, and
the newest assistant entry in the session-manager view at `agent_settled`. The last
is NOT an on-disk readback. Compare the saved JSONL separately if the issue recurs.
A raw-message ordinal is not a provider request ID; nested/interleaved calls need
manual correlation rather than an automatic blame assignment.

Delta labels are deduplicated, each shape is limited to 128 blocks, and capture
stops at 2 MiB with a limit marker and warning. Startup/write errors disable capture
with a generic warning; shutdown closes the file. Restart without the environment
variable/`-e` flag to remove the probe. No live configuration or package pin changes
are required.

Verification: seven Node tests cover projection/privacy, immutability, deduplication,
invalid inputs, lifecycle/private permissions, file-size cap, startup I/O failure,
and an injected close failure. Both review axes passed after fixing close-error handling.
`make test` includes them. Typechecked against 1.0.0 and 1.3.0 declarations; Biome
clean. A fresh 1.3.0 RPC `get_state` run loaded the extension, created a private trace,
and exited 0 without a model request.

## Required diagnosis and upgrade gates

1. Use the opt-in probe above during a recurrence in the affected long-running
   conversation. The two fresh-session attempts are complete and did not reproduce;
   do not repeat unbounded live calls. Record loaded runtime separately from the
   installed CLI version.
2. Compare raw -> normalized -> persisted types. If they diverge, isolate the first
   transforming layer and add a regression test there before changing code. If the
   provider already emits the marker as thinking, compare stock/request-formatting
   configurations before attributing it to either the model or our configuration.
3. Keep a fixture-driven integration gate in the eventual fix: wire text following
   thinking must stay visible with thinking collapsed, before and after session
   reload. Actual wire thinking must remain thinking; do not expose private blocks
   using content heuristics such as a sentence starting with an acknowledgement.
4. Reconcile `pi-subagents` against its latest release (last observed `v0.22.0`, fork
   currently based on `v0.19.0`). Pay particular attention to upstream completion
   delivery at parent boundaries versus our notice outbox and detached-session logic.
   Recheck tags before starting; do not mix this rebase with the classification probe.
5. Latest released bases checked on 2026-10-16: `pi-computer-use` remains at
   `v0.5.1` (upstream tags), and `pi-claude-auth` at `0.1.3` (npm). Those match our
   current fork bases; no release-base rebase is needed for either. Any further
   source work uses checkouts under `~/code`, never installed package trees.
   Plan-mode/todos remain excluded.
6. For each required change: document, run the owning repo's full gate, two-axis
   review, staged `make verify`, then release/tag, tap or package pin, and live
   `make verify`. Run the router's complete e2e gate after a core/subagents update.
7. Restart long-lived Pi processes before validating the deployed version. Confirm
   loaded runtime and installed version separately; retain the old release for rollback.

Status: classification cause unresolved. No production classification or rendering
behavior has been changed for this investigation.
