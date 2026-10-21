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
byte-identical to the fork except this README, `package.json` and comments in
`state/i18n-bridge.ts`. Deliberate deltas:

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

## Verification

The workspace gate (from the repository root, or standalone in this directory):

```sh
npm ci --ignore-scripts
# Put Bun 1.3.14 (see .bun-version) on PATH.
npm run check
```

`check` runs Biome, strict TypeScript, all 382 Vitest tests (including every
upstream test), and two native Bun interactive-row regressions. The test host
pins core `v1.3.0-nredd.6` release tarballs. Unpublished upstream mock helpers
are vendored under `.test-support/`; provenance and test counts are documented
[here](.test-support/README.md). Tests isolate HOME and use faux providers, never
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
  See [reconciliation and migration](./docs/plan-reconciliation.md).
  The heading shows `N/M plan items open`.
- **Done needs proof (nredd fork).** `completed` requires an `evidence` string
  (command + result, commit, test name); `deferred` requires a `reason`, and
  the user is notified when a plan item is deferred. Batches notify only final
  deferrals, while each operation reports its own outcome and reason. See
  [batch outcomes](./docs/batch-outcomes.md). If a run tries to finish with plan
  items open, the model gets one reminder listing them before it can wrap up.
  Reminders pause while Plan mode is active; old approved todos remain until a
  replacement is approved. Exiting planning without approval resumes the old
  obligations. Details in the
  [tool reference](./docs/tool-schema.md#plan-items).
- **Parallel sessions stay separate.** Task state is keyed by session, so a
  detached or child session can neither read nor overwrite the foreground list.
  Stale shutdowns use captured session identity and never assume ownership of
  the foreground. Replay skips malformed snapshots rather than replacing valid
  tasks, while accepting valid historical tasks without newer evidence fields.
- **Historical rows keep their own subjects.** Settled calls render from their
  validated result snapshots, not the current task list, including after reload
  and resize. Partial results and renderer probes do not change cached history.
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
[Configuration](https://github.com/nredd/pi-harness/blob/main/packages/todo/docs/configuration.md).

## Reference

- [`todo` tool reference](https://github.com/nredd/pi-harness/blob/main/packages/todo/docs/tool-schema.md)
  — every `todo` parameter, the status machine, the response envelope, and the
  exact error strings.
- [Configuration](https://github.com/nredd/pi-harness/blob/main/packages/todo/docs/configuration.md)
  — config file resolution, option validation rules, and the accepted keybinding
  grammar.
- [Overlay and `/todos`](https://github.com/nredd/pi-harness/blob/main/packages/todo/docs/overlay.md)
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

## License

MIT, retained from upstream -- see [LICENSE](https://github.com/nredd/pi-harness/blob/main/packages/todo/LICENSE).
