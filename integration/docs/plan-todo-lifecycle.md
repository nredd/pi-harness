# Plan todo lifecycle coverage

`scenarios/integration/test_plan_todos.py` exercises both extensions in one sandbox, using
Pi sessions rather than extension mocks. `HARNESS_LOCAL=pi-plan-mode,rpiv-todo` selects the
usual source checkouts; use `name=/absolute/worktree/path` entries when testing isolated worktrees.

- `test_plan_items_close_in_one_evidenced_batch` approves a three-item plan, closes all three in
  one atomic `todo.ops` call, requires completion evidence and a deferral reason, and verifies
  the `0/3 plan items open` heading plus persisted details.
- `test_closed_plan_heading_counts_sum` resumes that session through actual RPC and checks
  `/todos` reports `2 done, 1 deferred`, accounting for all three items with none left open.
- `scenarios/tui/test_todo_history.py` reloads and resizes the actual Pi host, checking that
  settled todo rows retain their own historical subject instead of today's renamed task.
- `test_replacement_approval_replaces_unfinished_plan_todos` resumes a session with unfinished
  work, plans a replacement, and approves it. Only the replacement plan's items remain.
- `test_declined_replacement_preserves_old_plan_todos` declines a replacement, drives the
  canonical `reproposal_confirmation` question in headless mode, verifies its cancelled result
  cannot authorize another completion, exits Plan mode, and confirms the original items remain.
- `test_plan_mode_confirmation.py` uses Pi's real RPC extension-UI protocol: canonical
  `Re-propose now` permits exactly one replacement completion, while `Not yet` and cancellation
  keep it blocked. It validates the normalized question labels, rather than a mock handler.
- `test_replanning_defers_old_reminder_across_compaction_and_restore` starts with approved work,
  enters replanning, forces real Pi compaction, resumes the persisted session, exits without an
  approval, and verifies old-plan reminders resume. It also appends the historical
  `plan-mode-state` envelope to the real session to cover its enabled/disabled fallback.
- The older seed/evidence/reminder scenarios keep the verbatim plan-event, proof requirement,
  and one-reminder-per-request contracts covered.

Fresh handoff and `/tree` navigation are Plan-mode-owned session routing paths. Fresh handoff
creates a new session; tree navigation restores branch-local state into the current session's
slot. Their plan lifecycle behavior is covered in `pi-plan-mode`'s
`test/` suite. The cross-package regression here targets the shared boundary: an approved plan
emits `pi-plan-mode:plan-approved`, and `rpiv-todo` must preserve or replace that session's plan
items only at an explicit approval boundary.

The headless declined-replacement test covers the `ui_unavailable` path. The RPC scenario
covers the affirmative and non-affirmative interactive answers through the real extension-UI
protocol; the Plan-mode unit suite separately owns custom-TUI layout and keyboard behavior.
