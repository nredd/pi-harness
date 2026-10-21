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
├─ ✓ Create DemoTodo domain entity
├─ ✓ Create IDemoTodoRepository interface
├─ ◐ Create DemoTodoRepository (creating the repository)
├─ ○ Register DI bindings
└─ ○ Add integration tests
```

- **Heading** — `▾ ● Todos (19 done, 1 deferred, 4 open, 2 in progress)` in the accent color while
  any task is `pending` or `in_progress`; dimmed with `○` once nothing is open.
  The counts cover the whole list, never just the visible rows, and always sum to
  the total (open = `pending` or `in_progress`; `in progress` is a subset of
  open, shown in the warning color of the `◐` marker; zero buckets are omitted). The
  marker becomes `▸` while collapsed. Click anywhere on the heading to toggle it.
  When non-plan todos exist next to plan items it also ends in
  `· N/M plan items open`.
- **Glyphs** — `○` pending, `◐` in_progress, `✓` completed, `⊖` deferred, `✗` deleted.
  Completed and deleted subjects render dim and struck through; deferred ones dim.
- **activeForm** — appended dim in parentheses, only while the task is
  `in_progress`.
- **Dependencies** — appended as `⛓ #1,#2` when the task has a `blockedBy` set.
- **`#id` prefix** — shown on every row only when at least one visible task
  carries a `blockedBy`. Without a `⛓ #N` anywhere, the per-row ids have nothing
  to point at, so they are omitted.
- **Prefixes** — `├─` on each row, `└─` on the last one. A blank spacer line is
  always appended below the panel so it is not flush against the input box.

Rows longer than the terminal width are truncated with `…`.

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

Click the heading to collapse the panel to two lines -- the heading plus a dim
`└─ ctrl+shift+t to expand` hint -- and click it again to expand. The disclosure
marker changes from `▾` to `▸`. The configured keyboard shortcut performs the
same toggle, and the hint always shows that key.

Rebind or disable the shortcut with the `collapseKey` option; see
[configuration.md](./configuration.md#collapsekey). If the shortcut is set to
`"off"` while the panel is collapsed, the hint becomes a static `collapsed`
label rather than advertising an unbindable key.

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
  ◐ #3 Create DemoTodoRepository (creating the repository)
── Completed ──
  ✓ #1 Create DemoTodo domain entity
  ✓ #2 Create IDemoTodoRepository interface
```

The header omits any count that is zero. Sections appear only when they have
tasks. Tombstoned tasks are never listed.

- With no tasks: `No todos yet. Ask the agent to add some!`
- In a non-interactive session: `/todos requires interactive mode`

## Localization

The overlay heading, the `+N more` summary, the collapse hint, the `/todos`
section headers, and the status words all localize through
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
