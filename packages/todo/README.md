# @nredd/pi-todo

[![npm version](https://img.shields.io/npm/v/@nredd/pi-todo.svg)](https://www.npmjs.com/package/@nredd/pi-todo)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<div align="center">
  <a href="https://github.com/nredd/pi-harness/tree/main/packages/todo">
    <img src="https://raw.githubusercontent.com/nredd/pi-harness/main/packages/todo/docs/cover.png" alt="pi-todo — a persistent todo overlay for Pi Agent, showing a task panel with completed, in-progress, and pending rows" width="50%">
  </a>
</div>

Give the model a task list you can see. `pi-todo` adds a `todo` tool, a
`/todos` command, and a live panel above the editor to
[Pi Agent](https://github.com/badlogic/pi-mono), so you always know what the
agent is doing now, what it finished, and what is queued. The list is rebuilt
from the conversation itself, so it survives `/reload` and compaction — useful
on long research → design → implement sessions.

## Fork changes

Imported from [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)
`packages/rpiv-todo` at fork commit `9a4e2e8` (`nredd/rpiv-todo`). Source, tests and docs are
based on that snapshot, with the workspace's injected-home seams and standalone test
support described below. Retained packaging deltas:

- Renamed to `@nredd/pi-todo`; `repository`, `homepage`, `bugs` and the doc/license links point at
  `nredd/pi-harness/packages/todo`. Links that credit upstream stay on `juicesharp/rpiv-mono`
- `author` dropped from `package.json`; the retained upstream MIT `LICENSE` carries attribution
- `@juicesharp/rpiv-i18n` is a hard `dependency` (`^2.13.9`), not an optional peer, and
  `peerDependenciesMeta` is removed. The English-only fallback in `state/i18n-bridge.ts` is kept
  but unreachable in a normal install; only its comments changed to say so
- `pi.image` points at `docs/cover.png` in this repository. The file is not packed
  (`!docs/*.png`); the URL resolves once the package is on `main`
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

The workspace gate (from the repository root, or standalone in this directory):

```sh
npm ci --ignore-scripts
# Put Bun 1.4.4 (see .bun-version) on PATH.
npm run check
```

`check` runs Biome, strict TypeScript, and all 408 Vitest tests (including every
upstream test) on both Node and Bun. The two real interactive settled-row regressions
run inside that same suite on both engines. The test host
pins core `v1.3.0-nredd.10` release tarballs. Unpublished upstream mock helpers
are vendored under `.test-support/`; provenance and test counts are documented
[here](.test-support/README.md). Tests inject temporary homes and use faux providers, never
a pi process or credentials.

Settled update/delete rows with a valid result snapshot retain that historical
subject. Legacy/error rows without one still read the live store and now call
`context.invalidate()` on foreground state changes, including replay and eviction.
Weak subscriptions avoid retaining discarded rows; render probes have no effects.

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

![Todo overlay panel: a Todos (2/7) heading above two struck-through completed rows, one in-progress row with its activity label, and four pending rows](https://raw.githubusercontent.com/nredd/pi-harness/main/packages/todo/docs/overlay.jpg)

Click the heading's `▾`/`▸` marker to collapse or expand the panel. The
`ctrl+shift+t` shortcut does the same thing. Resuming a session starts the panel collapsed (`collapseOnResume`). Run `/todos` at any time to print
the full list grouped by status.

## What you get

- **The plan stays on screen.** A panel above the editor shows every task with a
  status glyph, the label of whatever is in progress, and a `Todos (done/total)`
  heading — you never have to ask the agent where it is.
- **Tasks survive `/reload` and compaction.** Every change records the full
  post-mutation snapshot on the session branch, including changes made from a
  codemode script, and the list is replayed from there. No disk writes, nothing
  to lose.
- **Finished work gets out of the way.** Completed rows stay visible for the rest
  of the turn, then drop at the start of the next one; the panel disappears
  entirely when the list empties.
- **The overlay never eats your terminal.** Past the row budget it becomes a
  window over the whole list: scroll it with the mouse wheel, and `↑ N above` /
  `↓ N below` hints say what is out of view. Nothing is ever hidden.
- **Task status reflects actual work.** Mark every started task `in_progress`,
  including parallel work; assign `owner` to identify each worker. The owner shows
  on the row as `@auth-audit`; when it names a top-level subagent of this session
  (from [`pi-subagents`](https://github.com/nredd/pi-harness/tree/main/packages/subagents#events)
  lifecycle events, per the [owner match rule](#owner-match-rule))
  the row also shows that agent's live state, `queued`, `running`, `done`, `failed` or
  `stopped`. An
  `in_progress` todo whose agent failed or stopped is marked `✗ failed` or `✗ stopped`; the todo
  stays `in_progress` until the parent completes it with evidence. Complete each
  verified task immediately. Atomic batches may record independently verified
  results together, but must not delay individual completions. There is no
  global single-active-task limit. Plan text, completion evidence, and deferral
  reasons remain protected.
- **Requested changes cannot silently disappear.** Action-inapplicable fields
  reject the call, including an entire `ops` batch. `create` always starts
  `pending`; use an explicit `update` with its id to change status. Dependency
  updates use `addBlockedBy` / `removeBlockedBy`, never `blockedBy`.
- **The agent can sequence work, not just list it.** `blockedBy` dependencies are
  validated before anything is written — dangling ids, deleted dependencies,
  self-blocks, and cycles are all rejected.
- **An approved plan becomes the list, verbatim (nredd fork).** With
  [`pi-plan-mode`](https://github.com/nredd/pi-plan-mode), approving a plan seeds
  one todo per actionable bullet, copied word for word and tagged `[plan]`;
  context sections (`Summary`, `Not adopted`, `Assumptions`, ...) are skipped.
  Approved text cannot be edited and plan items cannot be deleted; activity
  labels, ownership, dependencies, and metadata remain editable. A revised
  approved plan replaces them. Status and evidence carry forward only for an
  unambiguous unchanged item, identified by its full heading path and work text.
  Legacy items without that identity restart pending on their next reapproval.
  See [reconciliation and migration](#plan-reconciliation).
  The heading shows `N/M plan items open`.
- **Done needs proof (nredd fork).** `completed` requires an `evidence` string
  (command + result, commit, test name); `deferred` requires a `reason`, and
  the user is notified when a plan item is deferred. Batches notify only final
  deferrals, while each operation reports its own outcome and reason. See
  [batch outcomes](#batch-outcomes). If a run tries to finish with plan
  items open, the model gets one reminder listing them before it can wrap up.
  Outside Plan mode, a run that settles with `in_progress` todos also reports them
  (`agent_settled` in `plan-hooks.ts`), grouped by why each is still open: `owner agent failed
  or stopped` (all named), `owner agent not found after resume`, `agent running for another session`, `held by the parent`, `agent running without a completion notice`, `blocked` and `agent running`, three per group
  then a count. `agent running` includes an owner agent still `queued`. `blocked` means a live
  `blockedBy` dependency: one `in_progress` whose owner agent has not failed or stopped, or one
  `pending` whose owner agent is running or queued with a verified completion notice. A todo is `held by the
  parent` when it has no owner, a free-text owner, an agent that finished without the todo being
  completed, or open blockers that are all dead (`deferred`, unowned `pending`, or abandoned), shown
  as e.g. `(by #3 deferred)`. Each displayed todo names its owner even when no agent state is known,
  alongside any blocker details, e.g. `(@release-team; by #3 deferred)`. An `Agent`-tool background spawn or resume is heard at `subagents:created`, so
  it counts as running while still queued; spawns that skip `created` (cross-extension RPC, the
  scheduler, `@handle`) are first heard at `subagents:started` and read `held` until then (or at `subagents:failed`, as `stopped`, if stopped while still queued). Its armed clause, `armed:
  no todo-owned wake (agent notices list session wakes; unlinked monitors arm no todo)`, says only that todos arm
  nothing themselves (with a monitored todo it reads `armed: monitor for #<id>`); the `subagents` and `session-kit` monitor notices say what does wake the
  parent. Background agents still arm session-wide, since they wake the parent on completion; monitors can sit for up to 7 days, so they arm only the
  todos they are linked to. Only a lifecycle event explicitly confirming an agent completion notice makes that owner a verified wake; foreground, silent RPC and older unknown agents warn on every settle. Abandoned, lost or silent work, and parent-held work while nothing is armed (below), is a warning repeated on every settle, so a stop with
  owned work pending and nothing to wake the parent is never silent. When every todo waits on a running agent or a live dependency
  it is info, shown once: a settle that changes no todo's group, owner, owner agent state, wake eligibility or blocker identity, status, owner or owner agent state
  repeats nothing until the next prompt from a person. Todo status never changes on its own, e.g.
  `Run ended with 2 in_progress todos, armed: no todo-owned wake (agent notices list session wakes; unlinked monitors arm no todo); owner agent failed or stopped: #3 Audit auth (@auth-audit failed); held by the parent: #6 Deploy`.
  After a process restart (`session_start` reason `startup`), an `in_progress` todo whose `owner` was already set when the session started and
  that no `subagents` event has named since is `owner agent not found after resume` (warning, every
  settle, all named): children die with the process, so it is not parent-held. `/new`, `/resume`,
  `/fork` and `/reload` are not that boundary: pi-subagents detaches still-running background agents.
  On every `session_start`, and on `subagents:announce_survivors` (which this extension sends once the session is bound and again
  at every settle), pi-subagents announces ALL running detached survivors in the process. Those registered under this session's
  file (after `/reload`, or a `/resume` back into the session that spawned them) arrive as `subagents:started` and are `running` and
  armed, with `subagents:completed` / `:failed` replayed when their results are delivered. Every other one arrives as `subagents:other_session_survivor` with the `sessionFile` it wakes: its result
  spools there, not here. Only one registered under a file this session was forked from (its header's `parentSession`, then that
  file's own, so a `/fork`, a fork of a fork, or a `/reload` in either) makes a todo it owns read
  `agent running for another session, which it wakes instead of this one` (info, once); it is never armed here and never triggers the
  held-work reminder. Only ancestors count, compared by the exact paths pi wrote (no normalization; an unreadable or moved ancestor ends the chain): a
  survivor of any other session (`/new`, `/resume` of another session, a sibling fork, or a descendant of this session) is not
  matched, because handles are per manager and a same-named dead owner must not hide behind it. That todo is `held` (or lost)
  and reminds as usual, the safe direction. A repeated `started` for an agent already
  running with the same identity changes nothing, so re-announcing a survivor never outranks a newer same-named agent. The set is rebuilt from each announcement, so a `/reload` loses nothing and a survivor that finished
  (even while this session was inactive) drops out at the next settle. An owner nobody names is `held`, never lost. A free-text owner (a person or team) is indistinguishable from a dead
  agent handle, so it lands there too until it is reassigned. Parent-held work warns only when nothing
  is armed: a running monitor started for it (`session-kit:monitor:started` / `:stopped` on `pi.events`, payload
  `{ sessionId, id, name, wake, match?, todos? }`) or a background agent with a verified completion notice makes it an info
  report, shown once like the other waiting groups. A monitor started with `todo: <id>` (or a list of ids, for one monitor serving several todos) arms only those todos, which reads
  `waiting on a monitor, which wakes the parent: #<id> <subject> (monitor <name>)` (info); once the monitor stops or
  expires with the todo still `in_progress` it is `held` again and warns. Other held todos still warn. A monitor
  with no `todo` arms no todo (it may be unrelated to the held work; before, it silenced every held todo and the held-work
  reminder), so link it with `todo: <id>`. `todo clear` (also inside an `ops` batch) drops links to cleared todos, and a tree navigation that changes the todos drops every link, since ids can be reused. Abandoned, lost and silent work always warn.
  When todos are held or lost and nothing is armed, nothing can wake the parent, so `agent_before_settle`
  appends one hidden `rpiv-todo-held-reminder` and requests one more request, once per prompt from a
  person (a plan reminder is independent). The `context` hook swaps the live list for the marker on that
  request only, like the plan reminder; it fires only if the todos are still held and unarmed then.
  Reminders pause while Plan mode is active; old approved todos remain until a
  replacement is approved. Exiting planning without approval resumes the old
  obligations. Details in the
  [tool reference](#plan-items).
- **Parallel sessions stay separate.** Task state is keyed by session, so a
  detached or child session can neither read nor overwrite the foreground list.
  Stale shutdowns use captured session identity and never assume ownership of
  the foreground. Replay skips malformed snapshots rather than replacing valid
  tasks, while accepting valid historical tasks without newer evidence fields.
  Owner agent state is display-only: a subagent never reads or writes the
  parent's list, and only the parent completes its todo. Without `pi-subagents`
  owners render without a state. An evicted agent keeps its last known state for
  the rest of the session, until 256 more recently updated agents push it out;
  agents are tracked per session, so after `/new` or
  `/resume` a todo never shows another session's agent.
- **Historical rows keep their own subjects.** Settled calls render from their
  validated result snapshots, not the current task list, including after reload
  and resize. Live owner agent state appears only on the overlay and `/todos`,
  never in a tool result or a settled row. Partial results and renderer probes do not change cached history.
- **Localized UI, no setup required.** Nine locales ship with the package and are
  served by [`@juicesharp/rpiv-i18n`](https://www.npmjs.com/package/@juicesharp/rpiv-i18n),
  a regular dependency.

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
fence character, opening-run length, and container-relative indentation, so an inner
````` fence cannot close an outer `~~~~` fence or create a fake todo. A nested fence ends
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

The SDK is a soft optional peer, loaded through a dynamic import at module init.
When it is absent, every call site returns its inline English literal and the
extension stays online: no warning, no crash. Install it at any time with
`pi install npm:@juicesharp/rpiv-i18n` and restart the session. To add or
override a translation, drop a `locales/<code>.json` file mirroring `en.json` —
see the `@juicesharp/rpiv-i18n` README's "Contributing translations" section.

## License

MIT, retained from upstream -- see [LICENSE](https://github.com/nredd/pi-harness/blob/main/packages/todo/LICENSE).
