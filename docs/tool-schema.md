# `todo` tool reference

Complete parameter schema, status machine, response envelope, and error strings
for the `todo` tool registered by
[`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo).

## Actions

| Action | Required params | What it does |
| --- | --- | --- |
| `create` | `subject` | Adds a task in `pending`, assigns the next id. |
| `update` | `id` + at least one mutable field | Changes status, fields, or dependencies. |
| `list` | — | Returns all tasks, optionally filtered by `status`. |
| `get` | `id` | Returns one task with its `blockedBy` and reverse `blocks` edges. |
| `delete` | `id` | Tombstones the task (`status: "deleted"`); it is not removed. Plan items can't be deleted. |
| `clear` | — | Drops every agent-created task. Plan items stay; the id counter resets to `1` only when nothing is kept. |

## Batching with `ops`

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
  final reason. See [batch outcomes](./batch-outcomes.md).

## Duplicate guard

While a plan is active, `create` fails when its subject matches a plan item
(case and whitespace-insensitive): `#7 is already a plan item; update it`.

## Parameters

```ts
todo({
  action: "create" | "update" | "list" | "get" | "delete" | "clear",

  // create-only
  subject?: string,                   // required for create
  blockedBy?: number[],               // initial dependency ids

  // create + update
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

## Status transitions

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

## Plan items

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
See [plan reconciliation](./plan-reconciliation.md) for provenance and migration.
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

## Dependencies

`blockedBy` holds the ids this task waits on. Validation runs before the state
is mutated, so a rejected call leaves the list untouched:

- a dependency id that does not exist is rejected;
- a dependency that is already tombstoned is rejected;
- blocking a task on itself is rejected;
- an `addBlockedBy` that would close a cycle in the graph is rejected.

`get` also reports the reverse edges as a `blocks:` line, derived from the other
tasks' `blockedBy` arrays.

## Return envelope

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

`details` is the persistence format. Every successful call embeds the complete
post-mutation snapshot, and the session-lifecycle handlers rebuild state by
walking the branch and taking the last valid snapshot they find, which is why
tasks survive `/reload` and compaction without any disk writes. Invalid task
shapes, duplicate ids, invalid counters, and dangling dependencies cause a
snapshot to be skipped, not partially installed. Historical completed tasks
without evidence remain readable; the current evidence rule applies to new
mutations.

## Content strings

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

## Error messages

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

## Prompt guidance

The tool ships a `promptSnippet` and ten `promptGuidelines` bullets telling the
model when to open a list, to keep exactly one task `in_progress`, to mark work
completed immediately rather than in batches, never to complete a task with
failing tests, the literal `update {id, status}` call shape for changing a
task's status, that `completed` needs `evidence`, and that plan items are
completed with evidence or deferred with a reason, never reported done while
open. Both are overridable — see
[configuration.md](./configuration.md#guidance).
