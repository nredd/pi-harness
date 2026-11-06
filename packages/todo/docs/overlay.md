# Overlay and `/todos` display

How
[`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo)
renders the task list — when the overlay appears, what each glyph means, how
overflow is trimmed, and which strings localize.

## When the overlay exists

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
(last-write-wins). See [tool-schema.md](./tool-schema.md#persistence) for where
snapshots are saved.

## Anatomy of a row

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

### Owner match rule

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

## Scrolling

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
budget. See [configuration.md](./configuration.md#maxwidgetlines).

## Collapsing

Click the heading to collapse the panel to one content line -- the heading. Click
it again to expand. The disclosure marker changes from `▾` to `▸`; the configured
keyboard shortcut performs the same toggle. A trailing blank spacer remains below
the panel.

Rebind or disable the shortcut with the `collapseKey` option; see
[configuration.md](./configuration.md#collapsekey).

## `/todos`

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

## Localization

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
