# @nredd/pi-todo

[![npm version](https://img.shields.io/npm/v/@nredd/pi-todo.svg)](https://www.npmjs.com/package/@nredd/pi-todo)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Give the model a task list you can see. `pi-todo` adds a `todo` tool, a
`/todos` command, and a live panel above the editor to
[Pi Agent](https://github.com/badlogic/pi-mono), so you always know what the
agent is doing now, what it finished, and what is queued. The list is rebuilt
from the conversation itself, so it survives `/reload`, tree navigation and compaction.

## Fork changes

Imported from [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)
`packages/rpiv-todo` at fork commit `9a4e2e8` (`nredd/rpiv-todo`). Source, tests and docs are
based on that snapshot, with the workspace's injected-home seams and standalone test
support described below. Retained packaging deltas:

- Renamed to `@nredd/pi-todo`; `repository`, `homepage`, `bugs` and the doc/license links point at
  `nredd/pi-harness/packages/todo`. Links that credit upstream stay on `juicesharp/rpiv-mono`
- `author` dropped from `package.json`; the retained upstream MIT `LICENSE` carries attribution
- `@juicesharp/rpiv-i18n` is a hard `dependency` (`^2.13.9`), not an optional peer, and
  `peerDependenciesMeta` is removed. The English-only fallback in `src/state/i18n-bridge.ts` is kept
  but unreachable in a normal install; only its comments changed to say so
- Remove gallery media and `pi.image`; runtime files live under `src/`
- The persisted config path stays `~/.config/rpiv-todo/` and the i18n namespace stays
  `@juicesharp/rpiv-todo`, for compatibility with existing configs and sessions
- There is no nested `package-lock.json`: the root workspace lock governs (`npm ci --ignore-scripts`).
  The packed contract `npm install`s the tarball into an empty consumer, resolving from the registry,
  and audits that fresh install

## In-process home injection

The default extension entry accepts `registerTodo(pi, importOverlay?, options?: { homeDir?: string })`.
An embedder can call `registerTodo(pi, undefined, { homeDir: "/temporary/home" })` to bind config,
guidance, shortcut, resume and overlay reads to that home without changing `HOME`.
Omitting `homeDir` keeps the call-time `os.homedir()` default. An absolute `XDG_CONFIG_HOME`
still overrides the config directory; if its file is missing, the legacy fallback uses
`<homeDir>/.config/rpiv-todo/config.json`. This is an in-process dependency, not a new
user setting, and it does not write or migrate config files. `importOverlay` retains its
existing optional lazy-loader seam.

## Verification

Run the [development gate](#standalone-test-support). Tests use temporary homes and faux providers,
not operator credentials. Valid settled-result snapshots preserve their historical subjects;
legacy/error rows without a valid snapshot follow live state through `context.invalidate()`.
Weak subscriptions do not retain discarded rows, and render probes have no effects.

## Install

```sh
pi install npm:@nredd/pi-todo
```

Restart your Pi session.

## Quick start

Run `/todos` after the restart to confirm the extension is loaded. On a fresh
session it prints:

```
No todos yet. Ask the agent to add some!
```

Then ask for something with several steps — "add a repository layer with tests,
and track it as todos". The model calls `todo` and the panel appears above your
input box, updating as work moves:



Click the heading's `▾`/`▸` marker to collapse or expand the panel. The
`ctrl+shift+t` shortcut does the same thing. Resuming a session starts the panel collapsed (`collapseOnResume`). Run `/todos` at any time to print
the full list grouped by status.

## What you get

- Create one task per discrete step, then explicitly update its status. Parallel tasks may be
  in progress; use owners and dependencies to show who is doing what.
- Approved plans seed immutable work items. Complete with evidence or defer with a reason.
  [Tool reference](#todo-tool-reference) covers atomic batches, transitions and plan reconciliation.
- The panel follows the active session branch through reload, tree navigation and compaction.
  Other sessions and child agents cannot read or overwrite the foreground list.
- Scroll the complete list with the mouse wheel or expand tool output. Collapse with the heading
  or configured shortcut. Completed rows leave the panel at the next turn; `/todos` still lists them.
- Owner agent status is display-only. The parent must complete its todo, even when the agent is done.
  [Display reference](#overlay-and-todos-display) covers matching, history, scrolling and localization.

## Completion and unattended work

Completion requires nonblank `evidence`; deferral requires a `reason`. Tell the user when a plan item
is deferred. Batches report each operation's outcome but notify only final net plan deferrals.
Open plan items trigger one wrap-up reminder per user prompt. Plan reminders and unattended-work
reminders pause during Plan mode; old approved obligations resume if replanning ends without approval.

Outside Plan mode, each settle reports remaining `in_progress` work without changing task status:

| Group | Meaning and action |
| --- | --- |
| Owner failed/stopped | Every affected todo is named. Inspect the result and complete with evidence, retry or explicitly defer. |
| Owner not found after resume | A process-startup owner has no subsequent lifecycle event. Children die on quit/restart; do not assume they survived. |
| Agent running for another session | A survivor belongs to this branch's ancestor session, which receives its result. It is not armed here. |
| Agent running without a completion notice | Foreground, silent RPC or unknown eligibility cannot promise a wake. The parent must arrange continuation. |
| Blocked | A live dependency is `in_progress` with no failed/stopped owner, or `pending` with a running/queued owner and verified completion notice. |
| Agent running | The matching owner is running or queued with a verified notice. Wait for its completion rather than polling. |
| Held by the parent | No owner, free-text owner, finished owner, or only dead blockers (deferred, unowned pending, abandoned). The parent still owns the next action. |

Reports show owners and blocker details even without known agent state. They list all failed/stopped
and lost owners, otherwise up to three per group and a remaining count. Abandoned, lost and silent
work warns on every settle. Parent-held work warns when nothing is armed; a verified background-agent
completion wake makes it informational. Waiting-only reports are info and repeat only when grouping,
owner, agent state, wake eligibility or blocker identity/status/owner changes, or after a new human prompt.

A monitor arms *only* todos passed to `monitor_start({todo: id})` (or a list, up to 20), via
`session-kit:monitor:started` / `:stopped` payload
`{sessionId, id, name, wake, match?, todos?}`. Unlinked monitors arm none. Linked held work reads
`waiting on a monitor, which wakes the parent`; stopping/expiry returns unfinished work to held.
Other held todos still warn. `clear`, including in a batch, drops cleared links; branch navigation
that changes todos drops all links because ids can be reused. Background agents arm session-wide;
monitors may run for seven days and therefore must be linked to the work they continue.

Held/lost work with no wake adds one hidden `rpiv-todo-held-reminder` and requests another turn,
once per human prompt, independently of the plan reminder. The context hook substitutes the live
list only on that request, and only if the work remains held and unarmed. A wake is not proof of
completion; only the parent changes todo status with evidence.

### Session switches and survivors

`/new`, `/resume`, `/fork` and `/reload` are not process restarts: pi-subagents detaches background
work and delivers to its spawning session. Todo asks `subagents:announce_survivors` when bound and
at every settle. Same-session survivors announce `subagents:started` and remain running/armed until
`:completed` / `:failed` is delivered. A queued Agent-tool spawn/resume is already known from
`subagents:created`; RPC/scheduler/mention spawns are known only at `started`, or `failed` if stopped
before starting. Until then their todos are held.

Other survivors announce `subagents:other_session_survivor` with the `sessionFile` they wake.
Only exact ancestor paths from persisted `parentSession` headers qualify as running for another
session; no normalization is inferred, and an unreadable/moved ancestor ends the chain. Sibling,
unrelated and descendant sessions cannot hide a dead same-named owner. Their todos remain held/lost
and remind normally. Ancestor survivors are informational once, never armed here and never a reason
for the held-work reminder. Repeated identical starts are no-ops, not newer owner matches.
Announcements rebuild the survivor set so completed survivors disappear even after inactivity.
An owner not named by an event, including a person/team label indistinguishable from a dead handle,
is held, not automatically lost; startup loss applies only to owners already present at startup.

Parallel session lists remain separate. Agent state is display-only and retained for up to 256
recently updated agents per session; eviction retains last-known state until displaced. No child
can complete or overwrite its parent's todos. Valid settled snapshots keep their own subjects,
including reload/resize, and never gain live owner state. Partial results and render probes do not
change cached history.

## Configuration

Optional. Create `~/.config/rpiv-todo/config.json` (or
`$XDG_CONFIG_HOME/rpiv-todo/config.json` if you set that variable):

```json
{
  "maxWidgetLines": 8,
  "collapseKey": "alt+t"
}
```

| Setting | What it does | Default |
| --- | --- | --- |
| `maxWidgetLines` | Content rows the overlay may use, heading included. Minimum `3`. Applies on the next repaint. Pi's tool-output expansion mode shows all tasks. | `12` |
| `collapseKey` | Key that collapses and expands the panel, in Pi keybinding form (`alt+o`, `ctrl+shift+t`). Set `"off"` to register no shortcut. Needs `/reload` to rebind. | `"ctrl+shift+t"` |
| `collapseOnResume` | Start the panel collapsed when a session is resumed. Set `false` to keep it expanded. Read at each session start. | `true` |
| `guidance` | Replaces the built-in instructions the extension gives the model about when and how to use the todo list. Needs `/reload`. | _(built-ins)_ |

A missing or malformed file falls back to these defaults. `pi-todo` only reads
this file — it never writes one. Full semantics:
[Configuration](#configuration-reference).

## Reference

- [`todo` tool reference](#todo-tool-reference)
  — every `todo` parameter, the status machine, the response envelope, and the
  exact error strings.
- [Configuration](#configuration-reference)
  — config file resolution, option validation rules, and the accepted keybinding
  grammar.
- [Overlay and `/todos`](#overlay-and-todos-display)
  — overlay lifecycle, glyphs, overflow behavior, `/todos` output, and
  localization.

## Requirements

- A Pi Agent host. No API key, no model selection, no native dependencies.
- An interactive session for the panel and `/todos`. Headless runs still get the
  `todo` tool; nothing is rendered.
- [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
  and `@juicesharp/rpiv-config` install automatically as dependencies.

## Related

- [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
  ([source](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-i18n))
  — localizes this extension's UI chrome and adds a `/languages` picker.
- [`@juicesharp/rpiv-pi`](https://www.npmjs.com/package/@juicesharp/rpiv-pi)
  ([source](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-pi))
  — the umbrella package that installs this extension alongside its siblings.

## `todo` tool reference

Complete parameter schema, status machine, response envelope, and error strings
for the `todo` tool registered by
[`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo).

### Actions

| Action | Required params | What it does |
| --- | --- | --- |
| `create` | `subject` | Adds a task in `pending`, assigns the next id. |
| `update` | `id` + at least one mutable field | Changes status, fields, or dependencies. |
| `list` | — | Returns all tasks, optionally filtered by `status`. |
| `get` | `id` | Returns one task with its `blockedBy` and reverse `blocks` edges. |
| `delete` | `id` | Tombstones the task (`status: "deleted"`); it is not removed. Plan items can't be deleted. |
| `clear` | — | Drops every agent-created task. Plan items stay; the id counter resets to `1` only when nothing is kept. |

Only fields applicable to the selected action are accepted, in flat calls and
inside `ops`. An unsupported field rejects the whole call before committing
anything; it is never silently ignored. In particular, `create` always starts
`pending` and rejects `status`, `evidence`, and `reason`. Use the returned id in
an explicit `update` to start, complete, or defer the task. `update` rejects
`blockedBy`; use `addBlockedBy` / `removeBlockedBy` instead.

### Batching with `ops`

Pass `ops` instead of a top-level `action` and fields to open or close many todos
in one call. The two forms are mutually exclusive.

```ts
todo({
  ops: [
    { action: "update", id: 1, status: "completed", evidence: "npm test: 42 passed" },
    { action: "update", id: 2, status: "deferred", reason: "needs a design call" },
    { action: "create", subject: "Follow up" },
    { action: "list" },
  ],
});
```

- Mutations (`create`, `update`, `delete`, `clear`) apply in order, so a later op
  sees an earlier one. Ids of todos a batch creates are sequential from the
  current next id; don't rely on referencing them in the same call.
- Atomic: the first invalid op discards the whole batch, and the error names it
  (`Error: ops[2]: evidence required ...`). Nothing is partially applied.
- `list` and `get` are answered from the FINAL state, whatever their position.
- Each op carries its own `evidence` / `reason`; plan-item rules (verbatim,
  undeletable, evidence to complete) hold inside a batch.
- No nesting, and `ops` can't be empty.
- Result: `Applied N ops`, then one `[i] ...` block per op, then the plan header
  when a plan is active. `details.action` is `"batch"`.
- Mutation results describe each operation at its own point in the batch,
  including its reason. User notifications describe only net plan deferrals:
  defer-then-reopen sends no warning; repeated deferrals notify once with the
  final reason. See [batch outcomes](#batch-outcomes).

### Duplicate guard

While a plan is active, `create` fails when its subject matches a plan item
(case and whitespace-insensitive): `#7 is already a plan item; update it`.

### Parameters

```ts
todo({
  action: "create" | "update" | "list" | "get" | "delete" | "clear",

  // create-only
  blockedBy?: number[],               // initial dependency ids

  // create + update
  subject?: string,                   // required for create; editable for non-plan tasks
  description?: string,               // long-form detail
  activeForm?: string,                // present-continuous label shown while in_progress
  owner?: string,                     // agent/owner assigned to this task
  metadata?: Record<string, unknown>, // on update, a null value deletes that key

  // update-only
  evidence?: string,                  // required with status "completed": the check that proves it
  reason?: string,                    // required with status "deferred": why it is descoped
  addBlockedBy?: number[],            // additive merge into blockedBy
  removeBlockedBy?: number[],         // additive removal from blockedBy

  // update / get / delete
  id?: number,

  // update (sets this task's status) or list (filters by status)
  status?: "pending" | "in_progress" | "completed" | "deferred" | "deleted",

  // list-only
  includeDeleted?: boolean,           // default false — hides tombstones
})
```

`update` merges `metadata` key by key into the existing record; passing `null`
for a key removes it, and emptying the record drops the field entirely.
`addBlockedBy` and `removeBlockedBy` are additive — do not resend the whole
array.

### Status transitions

| From | Allowed targets |
| --- | --- |
| `pending` | `in_progress`, `completed`, `deferred`, `deleted` |
| `in_progress` | `pending`, `completed`, `deferred`, `deleted` |
| `completed` | `deleted` |
| `deferred` | `pending`, `in_progress`, `deleted` |
| `deleted` | _(terminal)_ |

Completing costs proof: a transition to `completed` needs a non-blank
`evidence` (command + result, commit, or test name), stored on the task and
shown by `list`, `get`, and the expanded tool row. Deferring needs a `reason`;
reopening a deferred task drops it. Plan items (below) can't reach `deleted`.

A transition to the current status is always accepted and reported as a no-op.
`delete` keeps the task as a tombstone so historic `blockedBy` references still
resolve; tombstones are hidden from `list` unless you pass `includeDeleted: true`.

### Plan items

When [`pi-plan-mode`](https://github.com/nredd/pi-plan-mode) starts implementing
an approved plan, it emits `pi-plan-mode:plan-approved` on `pi.events` with
`{ version: 1, planId, plan, sessionId }`. rpiv-todo turns the plan into todos
tagged `source: "plan"`, text copied verbatim:

- `##`+ headings are groups (`planGroup`); the `#` title names the plan.
- Each top-level bullet is one item: its first line is the `subject`, nested
  lines are kept as `planText`. A prose-only section becomes one item named by
  its heading.
- Context is skipped: sections like `Summary`, `Key findings`, `Not adopted`,
  `Assumptions`, `Risks`, and a list led in by `Not adopted:` and the like.
  `Verification` / definition-of-done bullets are items.

Plan items' subject and description cannot change and they cannot be deleted.
Their activity labels, ownership, dependencies, and metadata remain editable.
Complete them with `evidence` or mark them `deferred` with a `reason`. A newly
approved plan replaces the plan items; status and evidence carry only between
unambiguous unchanged items with matching full scope and work text. Legacy
items without versioned identity restart pending on their next reapproval.
See [plan reconciliation](#plan-reconciliation) for provenance and migration.
Agent-created todos are untouched. Announcing the
same `planId` again is a no-op. The seeding is persisted as a `rpiv-todo-state`
custom entry, which replay reads like a tool result.

Without pi-plan-mode nothing is emitted and nothing changes; without rpiv-todo
the event has no listener.

When a run would end (`agent_before_settle`, outcome `completed`) with plan
items `pending` or `in_progress`, rpiv-todo appends one hidden marker message
and requests one more model turn. The `context` hook replaces the marker, on
that request only, with the open items and the deferred ones with their
reasons, telling the model not to report the work as done. One reminder per
user prompt; none without a plan, once every plan item is closed, or while
Plan mode is active. The active session branch retains mode history through
compaction, reload, and tree navigation. Old approved todos remain while
replanning; only replacement approval replaces them. Exiting planning without
approval resumes the old obligations.

### Dependencies

`blockedBy` holds the ids this task waits on. Validation runs before the state
is mutated, so a rejected call leaves the list untouched:

- a dependency id that does not exist is rejected;
- a dependency that is already tombstoned is rejected;
- blocking a task on itself is rejected;
- an `addBlockedBy` that would close a cycle in the graph is rejected.

`get` also reports the reverse edges as a `blocks:` line, derived from the other
tasks' `blockedBy` arrays.

### Return envelope

```ts
{
  content: [{ type: "text", text: string }], // human-readable summary of the op
  details: {                                 // full snapshot — replay reads this back
    action: TaskAction,
    params: Record<string, unknown>,
    tasks: Array<{
      id: number,
      subject: string,
      description?: string,
      activeForm?: string,
      status: "pending" | "in_progress" | "completed" | "deferred" | "deleted",
      blockedBy?: number[],
      owner?: string,
      metadata?: Record<string, unknown>,
      source?: "plan",                       // seeded from an approved plan
      planGroup?: string,                    // plan heading, verbatim
      planText?: string,                     // nested plan lines, verbatim
      evidence?: string,                     // proof recorded on completion
      reason?: string,                       // why it was deferred
    }>,
    nextId: number,
    error?: string,                          // present only on a rejected call
    plan?: { id: string, title: string },    // the approved plan, when one was announced
  }
}
```

`details` carries the complete post-call snapshot. Every state-changing call,
including an atomic `ops` batch, also appends a `rpiv-todo-state` custom entry.
Reads, no-op updates/batches, and rejected calls/batches append nothing. A batch
writes only its final state, never a provisional mutation that was rolled back.
This also persists nested codemode calls, whose results are not separate branch
messages. Plan approvals use the same custom entry. Custom entries are not sent
to the model.

New fork custom snapshots include `persistenceVersion: 1`: every subsequent
mutation is persisted, so replay ignores potentially stale outer/read tool
results. Unmarked upstream custom entries without `plan` already have that
same authoritative behavior. Legacy fork Plan snapshots have `plan` but no
marker, and were followed by tool-result-only mutations: replay those branches
chronologically until the first authoritative entry. A completed legacy task
must not roll back to its earlier approved/pending snapshot.

Replay retains `plan`/`PlanRef`, deferral reasons and evidence, cloning nested
metadata so restored state cannot mutate historical entries. Invalid task
shapes, duplicate ids, invalid counters, and dangling dependencies cause a
snapshot to be skipped, not partially installed. Historical completed tasks
without evidence remain readable; the current evidence rule applies to new
mutations. Tasks survive `/reload`, `/resume`, `/tree` and compaction.

### Content strings

| Situation | `content[0].text` |
| --- | --- |
| Created | `Created #3: Write the parser (pending)` |
| Updated with a status change | `Updated #3 (pending → in_progress)` |
| Updated without a status change | `Updated #3` |
| Update that changed nothing | `No change: #3 already matches the requested values (status: in_progress)` |
| Deleted | `Deleted #3: Write the parser` |
| Cleared | `Cleared 7 tasks` (with plan items: `...; kept 5 plan items (...)`) |
| Deferred plan item | `Updated #3 (pending → deferred). Tell the user this plan item is descoped and why: <reason>` |
| Batch | `Applied 3 ops`, `[0] Created #1: ...`, ... |
| `list` header with a plan | `Plan: <title> -- 3/5 plan items open` |
| `list` row | `[in_progress] #3 Write the parser (writing the parser) ⛓ #1,#2` |
| `list` plan row | `[pending] #3 <subject> [plan: <group>]`, then the item's `planText`, `evidence:`, or `deferred:` lines indented |
| `list` with nothing to show | `No tasks` |
| Any rejection | `Error: <message>` |

The `No change` reply exists so a model that re-issues an identical update sees
that it was a no-op instead of a fresh `Updated #N`.

### Error messages

| Message | Cause |
| --- | --- |
| `subject required for create` | `create` without a non-blank `subject`. |
| `blockedBy: #N not found` | `create` naming an unknown dependency. |
| `blockedBy: #N is deleted` | `create` naming a tombstoned dependency. |
| `id required for update` / `get` / `delete` | `id` omitted. |
| `#N not found` | No task with that id. |
| `update requires at least one mutable field: subject, description, activeForm, status, evidence, reason, owner, metadata, addBlockedBy, or removeBlockedBy` | `update` with only an `id`. |
| `evidence required to mark a task completed: ...` | `completed` without non-blank `evidence`. |
| `reason required to defer a task: ...` | `deferred` without non-blank `reason`. |
| `evidence only applies to a completed task (status: completed)` | `evidence` on a task that isn't ending up `completed`. |
| `reason only applies to a deferred task (status: deferred)` | `reason` on a task that isn't ending up `deferred`. |
| `#N is a plan item from the approved plan and can't be deleted: ...` | `delete` or `status: "deleted"` on a plan item. |
| `#N is a plan item; its subject and description are the approved plan's text and can't be edited` | Changing a plan item's text. |
| `illegal transition completed → in_progress` | Target status not reachable from the current one. |
| `cannot block #N on itself` | `addBlockedBy` includes the task's own id. |
| `addBlockedBy: #N not found` / `is deleted` | Unknown or tombstoned dependency. |
| `addBlockedBy would create a cycle in the blockedBy graph` | The edge would close a cycle. |
| `#N is already deleted` | `delete` on a tombstone. |

Errors are returned in-band: `content` carries `Error: …` and `details.error`
carries the bare message. Task state is unchanged.

### Prompt guidance

The tool ships a `promptSnippet` and `promptGuidelines` bullets telling the
model when to open a list, to mark every started task `in_progress`, including
parallel work, and use `owner` to identify each worker. Each verified task is
completed immediately; atomic batches record only independently verified outcomes
together and never delay an individual completion. The guidance also
covers failing tests, the literal `update {id, status}` call shape for changing
a task's status, `completed` evidence, and plan items, whose text stays locked
and which must be completed with evidence or deferred with a reason before
work is reported done. Both are overridable — see
[Guidance](#guidance).

## Batch outcomes

`todo({ ops })` is atomic: a failed operation rejects the whole call and keeps
its input state. Successful mutations still execute in order, so each mutation
records its own immutable outcome when it runs.

That matters when later operations change or remove the same task. For example,
creating a task, clearing it, and creating another task with the reused id
reports both created subjects correctly. Likewise, successive deferrals report
the reason supplied by each operation, even if a later operation changes that
reason or reopens the task.

`list` and `get` are deliberately different. They are read operations and are
resolved after every mutation has succeeded, against the final batch state.
Their result lines therefore describe the final task list, regardless of where
they occur in `ops`.

Plan-item deferral warnings are also evaluated once after the complete call:

- a task deferred and then reopened produces no warning;
- a newly deferred task produces one warning with its final reason;
- a task that was already deferred produces a warning only when its final
  reason changed.

This coalescing affects only user notifications. The operation result text
continues to show each successful mutation's local outcome.

## Plan reconciliation

Seeding reads the plan from `pi-plan-mode:plan-approved` verbatim. When the user edited the plan
with `Edit plan…` before implementing, that payload is the edited text.

Approving a revised plan replaces only the todos with `source: "plan"`. Agent-created
items remain in place. If an agent-created item was blocked by a removed plan item, that
removed id is dropped from its `blockedBy` list. This is the existing dependency behavior:
no replacement dependency is inferred, and no new dependency edge is introduced.

Each seeded plan todo persists this identity:

```ts
planIdentity: {
  version: 1,
  headingPath: string[],
  workBody: string,
}
```

`headingPath` is every enclosing work-section heading (`##` and deeper), verbatim; the `#` title names the plan rather than its work. `workBody` is the exact Markdown work
body: a bullet's text plus nested lines, or a work section's prose and code, prefixed by
shared work context from enclosing sections. When a section has both prose and bullets,
the prose becomes its own todo and scopes the bullets. A colon-ended list lead-in scopes
its bullets without creating a label-only todo. Changing shared or ancestor work resets
related bullets rather than carrying proof into a revised scope. Leading code also scopes
subsequent bullets; a code-only work section becomes one heading-named todo, never tasks
for example bullets inside the code. The identity is deliberately
strict. A changed heading, bullet, nested line, or prose body starts a new pending todo rather
than attaching old proof to revised work.

On re-approval, completed or deferred `status`, `evidence`, and `reason` carry only when
exactly one prior version-1 identity and exactly one incoming identity match. Pending and
in-progress work restarts pending, so provenance never implies that work progressed across
an approval. Repeated identical bullets are ambiguous, so every duplicate starts pending.
Tasks written by an older extension without a versioned identity never carry state on their
next approval.

A carried todo records where its state came from:

```ts
planProvenance: { planId: string, taskId: number }
```

Both fields are part of the normal persisted task snapshot. Markdown fences are tracked by
fence character, opening-run length, and container-relative indentation. An inner backtick fence
cannot close an outer tilde fence or create a fake todo. A nested fence ends
when its list container ends; root four-space-indented code is not a Markdown fence.

## Configuration reference

Every option
[`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo)
reads, where the file lives, and exactly what happens when a value is wrong.

### Where the file lives

The config file is optional. It is resolved in this order:

1. `$XDG_CONFIG_HOME/rpiv-todo/config.json` — used when `XDG_CONFIG_HOME` is set
   to an absolute path. A bare `~` or a leading `~/` is expanded first; a `~user`
   form is not expanded and therefore falls through.
2. `~/.config/rpiv-todo/config.json` — used when `XDG_CONFIG_HOME` is unset,
   empty, whitespace-only, or relative.
3. If the XDG file does not exist, the legacy `~/.config/rpiv-todo/config.json`
   is read anyway, so a pre-XDG file is still found after you set
   `XDG_CONFIG_HOME`. This fallback is one-way: if the XDG file exists but is
   malformed, you get a warning and defaults — it does **not** quietly read the
   legacy file instead.

Both files missing means every default applies. Malformed JSON prints a
`rpiv-config: invalid JSON at …` warning and is treated as `{}`. A JSON array or
a non-object value (`null`, a string, a number, a boolean) is silently treated as
`{}` — no warning.

`rpiv-todo` never writes this file — you create and edit it yourself, and the
extension only reads it.

### Example

```json
{
  "maxWidgetLines": 8,
  "collapseKey": "alt+t",
  "guidance": {
    "promptSnippet": "Use the `todo` tool to track multi-step work before starting it.",
    "promptGuidelines": [
      "Create one task per discrete step.",
      "Mark a task in_progress while working on it; completed when done."
    ]
  }
}
```

### `collapseOnResume`

**Default `true`.** A resumed session (`session_start` reason `resume`) renders the
panel collapsed. Only the boolean `false` disables it; any other value keeps the
default. Read at each session start, no `/reload`.

### `maxWidgetLines`

**Default `12`.** The content-row budget for the overlay — the heading row and,
on overflow, the `+N more` summary row both count against it. Only the trailing
blank spacer sits outside the budget, so `12` renders up to 13 terminal rows.

- Floor of `3`. A number below `3` falls back to the default.
- A non-number falls back to the default.
- No ceiling.
- Read fresh on every render, so a change takes effect on the next repaint —
  no `/reload`.
- Pi's tool-output expansion mode (`ctrl+o` by default) temporarily overrides
  this budget and shows every task; collapsing restores the configured budget.

### `collapseKey`

**Default `"ctrl+shift+t"`.** The shortcut that collapses and expands the
overlay.

The value is trimmed and lowercased, then matched against Pi's keybinding
grammar: zero or more distinct modifiers joined by `+`, then a base key.

| Part | Accepted |
| --- | --- |
| Modifiers | `ctrl`, `shift`, `alt`, `super` — each at most once |
| Base key | one printable character (`a`, `7`, `]`, `/`, …) |
| Base key | a named key: `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`, `home`, `end`, `pageup`, `pagedown`, `up`, `down`, `left`, `right`, `f1`–`f12` |

Examples: `alt+o`, `ctrl+shift+t`, `super+alt+f5`.

- A missing, empty, blank, non-string, or ungrammatical value falls back to the
  default. The grammar is checked strictly on purpose: Pi takes the last `+`-part
  as the base key and ignores unknown parts, so a typo like `ctr+]` would
  otherwise capture every bare `]` keypress globally.
- `"off"` disables the feature — no shortcut is registered at all.
- The binding is resolved **once at extension load**. After editing this value,
  run `/reload` to rebind; until you do, the old key stays active even though the
  collapsed panel's hint text (which is resolved per render) already shows the
  new one.

### Guidance

`guidance.promptSnippet` (string) and `guidance.promptGuidelines` (array of
strings) replace the prompt copy the `todo` tool advertises to the model. Both
are absent by default, in which case the built-in snippet and the eight built-in
guideline bullets are used.

- `promptSnippet` must be a non-empty string; an empty string or a wrong type
  falls back to the default.
- `promptGuidelines` must be a non-empty array of non-empty strings. A non-array,
  or an array containing an empty string, falls back to the default — the array
  is all-or-nothing, not merged item by item.
- Both are read at extension load, so `/reload` after editing them.

### Environment variables

| Variable | Effect |
| --- | --- |
| `XDG_CONFIG_HOME` | Relocates the config directory, as described above. |
| `HOME` | Anchors `~/.config` when `XDG_CONFIG_HOME` does not apply. |

`rpiv-todo` reads no environment variables of its own. If you have
[`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
installed, that package has its own locale configuration and its own env-var
chain — see its README.

## Overlay and `/todos` display

How
[`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo)
renders the task list — when the overlay appears, what each glyph means, how
overflow is trimmed, and which strings localize.

### When the overlay exists

The widget is mounted above the Pi editor under the key `rpiv-todos`.

| Stage | Condition |
| --- | --- |
| Created | At the first session start that has a UI. A headless session never creates it. |
| Registered | Only while at least one overlay-visible task exists. The widget unregisters itself when the list empties, and re-registers when a task reappears. |
| Bound | Only the foreground session's overlay is refreshed. A detached or child session has its own task state and never rebinds or repaints the foreground panel. |
| Disposed | On the foreground session's shutdown. A child session shutting down leaves the overlay alone. |

Task state is partitioned by session id, so parallel sessions cannot read or
overwrite each other's lists. Nothing is written to disk: on session start,
compaction, and session-tree changes, the list is rebuilt by walking the branch
and taking the last saved snapshot, which replaces the whole list
(last-write-wins).

### Anatomy of a row

```
▾ ● Todos (2 done, 3 open, 1 in progress)
├─ ✓ #1 Create DemoTodo domain entity
├─ ✓ #2 Create IDemoTodoRepository interface
├─ ◐ #3 Create DemoTodoRepository @repo-writer running (creating the repository)
├─ ○ #4 Register DI bindings
└─ ○ #5 Add integration tests
```

- **Heading** — `▾ ● Todos (19 done, 1 deferred, 4 open, 2 in progress)` in the accent color while
  any task is `pending` or `in_progress`; dimmed with `○` once nothing is open.
  The counts cover the whole list, never just the visible rows. Done + deferred +
  open equals the total (open = `pending` or `in_progress`; `in progress` is a
  subset of open and is not added again, shown in the warning color of the `◐` marker; zero buckets are omitted). The
  marker becomes `▸` while collapsed. Click anywhere on the heading to toggle it.
  When non-plan todos exist next to plan items it also ends in
  `· N/M plan items open`.
- **Glyphs** — `○` pending, `◐` in_progress, `✓` completed, `⊖` deferred, `✗` deleted.
  Completed and deleted subjects render dim and struck through; deferred ones dim.
- **Owner** — `@owner`, dim, right after the subject. When the owner names a
  top-level subagent that `pi-subagents` reported to this session on `pi.events`
  (`subagents:created` / `started` / `completed` / `failed`), chosen by the
  [owner match rule](#owner-match-rule), the agent's last known state follows:
  `queued` (accent), `running` (accent), `done` (success), `failed` (error) or `stopped` (muted).
  `queued` is a background spawn or resume heard at `subagents:created` before it
  starts. A queued resume identifies the exact preceding `settleSeq` and its new
  `queuedResumeSeq`; stale re-announcements or foreground handoffs cannot override a later state.
  Free text that matches no agent shows only `@owner`. Another session's agents
  never match, so `/new`, `/fork` or `/resume` starts with no states; only a `/reload`, or a `/resume` back into the session that spawned them, hears that session's detached survivors again (survivors registered under a session file this one was forked from are heard as running for that session, with no state; those of any other session, e.g. a sibling fork or a descendant, are ignored). An `in_progress` todo whose agent
  failed or stopped is marked in the error color, `✗ failed` or `✗ stopped`. The
  todo's own status never changes: the parent completes it with evidence.
- **activeForm** — appended dim in parentheses, only while the task is
  `in_progress`.
- **Dependencies** — appended as `⛓ #1,#2` when the task has a `blockedBy` set.
- **`#id` prefix** — shown on every task row. It is the stable todo identifier,
  independent of any `#N` text in the task subject.
- **Prefixes** — `├─` on each row, `└─` on the last one. A blank spacer line is
  always appended below the panel so it is not flush against the input box.

Rows longer than the terminal width are truncated with `…`.

#### Owner match rule

Both the owner and every agent key are slugged like a handle (case, a leading `@`,
spaces and punctuation ignored, so `Auth Audit` matches `auth-audit`). An owner can
match an agent exactly, by its id, a previous id, its `handle` or its `name`
(`auth-audit-2` for a numbered retry), or loosely, by its `nameBase` (the spawner's
`name` before numbering, `auth-audit`). Agents tracked beyond the newest 256 per
session are forgotten.

Each conversation is dated from its *spawn*, not its start: pi-subagents stamps
`spawnSeq` when the agent is created, before any time queued, and `settleSeq` on each
settle, from one counter. The spawn is set once per id and carried to the new id when
an evicted agent is reopened (`previousId`); the latest start and latest settle move
with every resume. Without those stamps (an older pi-subagents) pi-todo falls back to
the order in which it first heard of each agent. Then:

- With an exact match (the most recently updated, if several), that agent's state
  shows, unless some *other* agent whose `nameBase` matches was spawned after the
  exact match last settled. That is a retry under the same name, and of those the
  one started most recently shows instead.
- With an exact match `queued`, the most recently settled `nameBase` match spawned after that
  queue entry shows instead, if any: a queued spawn or resume may never run, and a newer settled
  sibling says more. A resumed owner's earlier siblings cannot mask its new queue entry.
- With no exact match, the most recently updated `nameBase` match shows.

So for owner `Auth Audit`:

| Sequence | Shows |
| --- | --- |
| `auth-audit` fails, then retry `auth-audit-2` starts | `running` (the retry) |
| `auth-audit` runs, sibling `auth-audit-2` starts and fails | `running` (the owner) |
| `auth-audit` runs, sibling `auth-audit-2` starts, then `auth-audit` fails | `✗ failed` (the owner) |
| `auth-audit` runs, sibling `auth-audit-2` starts, then `auth-audit` completes | `done` (the owner) |
| `auth-audit` queued, sibling `auth-audit-2` starts and fails | `✗ failed` (the sibling) |

A sibling spawned while the owner ran never masks the owner's own outcome, even when
it sat queued until the owner's settle freed its slot, or is later resumed or reopened. The same holds for an unnamed
`explore` beside a scout named `Explore` (`explore-2`). A resumed owner is running
again and decides once more.

### Scrolling

The content-row budget is `maxWidgetLines` (default `12`), and the heading counts
against it. When there are more tasks than fit, the panel is a fixed-height
window over the whole list, in task order:

- scroll with the mouse wheel over the panel; one notch moves `|wheelDelta|` rows,
  so it follows Pi's `fullscreenWheelScrollLines` and the Alt multiplier;
- the first or last row becomes a dim `↑ N above` / `↓ N below` hint while tasks
  are out of view;
- a wheel at either end (or over a list that fits) falls through to the
  transcript;
- when the first `in_progress` task changes and is out of view, the window jumps
  to it once; a manual scroll then sticks until the active task moves again;
- collapsing resets the position.

There are no keyboard scroll bindings. Use Pi's tool-output expansion shortcut
(`ctrl+o` by default) to show every task at once; collapsing it reapplies the
budget. See [`maxWidgetLines`](#maxwidgetlines).

### Collapsing

Click the heading to collapse the panel to one content line -- the heading. Click
it again to expand. The disclosure marker changes from `▾` to `▸`; the configured
keyboard shortcut performs the same toggle. A trailing blank spacer remains below
the panel.

Rebind or disable the shortcut with the `collapseKey` option; see
[`collapseKey`](#collapsekey).

### `/todos`

`/todos` prints the whole list grouped by status, independent of the overlay's
row budget and auto-hiding:

```
2/7 completed · 1 in progress · 4 pending
── Pending ──
  ○ #4 Register DI bindings
  ○ #5 Add integration tests    ⛓ #4
  ○ #6 Wire up the HTTP endpoint
  ○ #7 Update the API docs
── In Progress ──
  ◐ #3 Create DemoTodoRepository @repo-writer running (creating the repository)
── Completed ──
  ✓ #1 Create DemoTodo domain entity
  ✓ #2 Create IDemoTodoRepository interface
```

Owners and their agent state print as on the overlay, uncolored. The header omits any count that is zero. Sections appear only when they have
tasks. Tombstoned tasks are never listed.

- With no tasks: `No todos yet. Ask the agent to add some!`
- In a non-interactive session: `/todos requires interactive mode`

### Localization

The overlay heading, the `+N more` summary, the `/todos` section headers, and
the status words all localize through
[`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n)
when that package is installed. Bundled locales: `de`, `en`, `es`, `fr`, `pt`,
`pt-BR`, `ru`, `uk`, `zh`.

LLM-facing output — the tool response envelope, reducer error messages, and the
schema descriptions — stays English by design.

The i18n bridge loads dynamically and retains an English-only fallback if the SDK is absent.
Normal installs receive the SDK as a hard dependency, not an optional peer. To add or
override a translation, drop a `locales/<code>.json` file mirroring `en.json` —
see the `@juicesharp/rpiv-i18n` README's "Contributing translations" section.

## License

MIT, retained from upstream -- see [LICENSE](https://github.com/nredd/pi-harness/blob/main/packages/todo/LICENSE).

## Standalone test support

Source provenance: `juicesharp/rpiv-mono` release `54df50eea935fc9753edc300d5f23c5e28d906d7`
(`@juicesharp/rpiv-todo@2.13.9`, subtree split `7903c76b`). Licensed, unchanged
`tests/fixtures/upstream/{session,theme}.ts` come from upstream `packages/test-utils/`.
The local barrel exports the used helpers; Pi API/context doubles use `@nredd/pi-test-lib/pi`.
The Vitest configuration aliases unpublished `@juicesharp/rpiv-test-utils` to that barrel.
Root `scripts/package_contracts.py` owns tarball membership and production-source completeness.

From the repository root:

```sh
make install-owned
npm run check --workspace @nredd/pi-todo
make check
```

The workspace check runs Biome, strict TypeScript and the full Vitest suite on Node and pinned Bun,
including upstream cases and both real interactive settled-row regressions. The development host is
core `v1.3.0-nredd.11` release tarballs, not a live Pi process. From `packages/todo`, target tests with:

```sh
node ../../scripts/run-vitest.ts node tests/home-injection.test.ts tests/todo-parallel-guidance.test.ts
```

Fixtures inject disposable homes into config, tool, extension and overlay callers without mutating
`HOME` or `USERPROFILE`. `XDG_CONFIG_HOME` alone is insufficient: a missing XDG file
must fall back into the same injected home, not the operator's. Present malformed XDG files never fall
back. `home-injection.test.ts` checks zero real-home probes. Setup retains upstream state/i18n reset
and config cleanup; the JSON loader stays upstream's `loadJsonConfig`.

The real core interactive harness and VirtualTerminal check legacy snapshot-less update/delete rows
refresh after the live subject changes. Valid historical snapshots intentionally remain unchanged.
These are rendering regressions, not a reason to weaken result-history assertions.

## Package layout

Runtime code and locales live under `src/`; tests mirror it under `tests/`, with injected-home fixtures under `tests/fixtures/`. The `rpiv-test-utils` alias still resolves the licensed session/theme fixtures in `tests/fixtures/upstream/`; Pi API/context doubles use `@nredd/pi-test-lib/pi`. Upstream updates are manual ports. The root Biome override preserves the existing upstream non-null assertions, generic test-tool doubles, and control-character sanitization regexes; this layout change does not redesign their types or behavior.
