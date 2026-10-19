# Plan todo lifecycle coverage

`integration/inprocess/plan-todos.test.ts` runs the real Gitlinked `pi-plan-mode` and `rpiv-todo`
entries in one core harness session, under Vitest and Bun. No extension mocks or Pi process.

- Approval seeds the exact plan bullets before any `todo` call
- One evidenced/deferred `todo.ops` batch closes all three items. A file-backed reopen checks
  `/todos` reports `2 done, 1 deferred`, with no open counts
- Approved replacement work supersedes old unfinished items only after the canonical RPC
  `Implement here` selection. A decline plus unanswered confirmation cannot overwrite them
- Real core compaction consumes scripted summary/prefix replies. Replanning suppresses old-work
  reminders across compaction, dispose/reopen and legacy `plan-mode-state` entries; exit restores them
- Bare completion is refused; the same update with evidence succeeds
- A premature done reply gets exactly one request-local reminder with only open items. The session
  persists only its short hidden marker, never the expanded open-item list

`support.ts` checks host identity before importing each fork. Keep their `node_modules/` absent.
`isolateStackHome()` isolates Pi and rpiv config, including legacy HOME paths. See `docs/ci.md`.

`integration/inprocess/todo-history-session.test.ts` owns actual host row rendering, file-backed
history, resource-loader reload and resize under Vitest and Bun.
`test_plan_mode_confirmation.py` still owns the real RPC extension-UI protocol. The Plan-mode
fork's native suite owns custom-TUI keyboard/layout, fresh handoff and tree routing.
