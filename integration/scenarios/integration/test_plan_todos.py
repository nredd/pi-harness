"""An approved plan becomes verbatim todos, `completed` costs evidence, and open items block "done".

The incident: after a plan was approved, the implementing agent paraphrased it into its own
todos, ticked them without proof, and reported everything done with a third of the plan open.
This runs the real installed pair, headless: pi-plan-mode approves a plan (`/plan implement`),
rpiv-todo seeds the plan's items from the `pi-plan-mode:plan-approved` event, rejects an
unproven completion, and reminds the model of the open items when the run tries to finish.

References:
- rpiv-todo fork: https://github.com/nredd/rpiv-todo
- pi-plan-mode fork: https://github.com/nredd/pi-plan-mode
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from harness.headless import RunResult, ToolOutcome, run_headless
from harness.paths import FAUX_EXTENSION
from harness.sandbox import Sandbox, build_sandbox, local_overrides_from_env
from scenarios.integration.test_session_kit_quota import rpc

if TYPE_CHECKING:
    from pathlib import Path

pytestmark = pytest.mark.integration

PLAN = """# Ship widgets

## Work
- Add the `alpha` module
- Wire `beta` into the CLI

## Verification
- `make test` passes
"""
PLAN_ROWS = [
    "[pending] #1 Add the `alpha` module [plan: Work]",
    "[pending] #2 Wire `beta` into the CLI [plan: Work]",
    "[pending] #3 `make test` passes [plan: Verification]",
]
REPLACEMENT_PLAN = """# Ship widgets v2

## Work
- Replace `alpha` with `gamma`

## Verification
- `make verify-fast` passes
"""
REPLACEMENT_ROWS = [
    "[pending] #4 Replace `alpha` with `gamma` [plan: Work]",
    "[pending] #5 `make verify-fast` passes [plan: Verification]",
]
REPROPOSAL_CONFIRMATION = {
    "mode": "reproposal_confirmation",
    "questions": [
        {
            "id": "confirm",
            "header": "Confirm",
            "question": "Re-propose the revised plan?",
            "options": [
                {"label": "Anything", "description": "The tool replaces this option."},
                {"label": "Else", "description": "The tool replaces this option too."},
            ],
        }
    ],
}
EVIDENCE = "uv run pytest tests/test_alpha.py: 3 passed"
BATCH_EVIDENCE = "make verify-fast: 42 passed"
DEFER_REASON = "Blocked on the upstream CLI API."
PREMATURE_DONE = "All done!"
DRAFTING_REPLACEMENT = "Drafting a replacement plan."
CONTINUE_OLD_PLAN = "Continue the original approved plan."
REMINDER_MARKER = "[rpiv-todo] Plan items were still open when this run tried to finish."
REMINDER_TYPE = "rpiv-todo-plan-reminder"


def append_legacy_plan_mode_state(session: Path, enabled: bool) -> None:
    """Append the historical plan-mode state envelope to an otherwise real Pi session.

    Parameters:
        session (Path): persisted Pi session to extend.
        enabled (bool): historical mode value to restore.
    """
    entries = [json.loads(line) for line in session.read_text().splitlines() if line.strip()]
    session.write_text(
        "\n".join(
            [
                *(json.dumps(entry) for entry in entries),
                json.dumps(
                    {
                        "type": "custom",
                        "id": f"legacy-plan-mode-{'on' if enabled else 'off'}",
                        "parentId": entries[-1]["id"],
                        "timestamp": "2026-10-16T00:00:00.000Z",
                        "customType": "plan-mode-state",
                        "data": {"enabled": enabled},
                    }
                ),
            ]
        )
        + "\n"
    )


def todo(**args: Any) -> dict[str, Any]:
    """A faux step calling `todo` once.

    Parameters:
        **args (Any): tool arguments.

    Returns:
        dict[str, Any]: faux script step.
    """
    return {"tools": [{"name": "todo", "args": args}]}


@pytest.fixture(scope="module")
def box(tmp_path_factory: pytest.TempPathFactory, template_home: Path) -> Sandbox:
    """One sandbox for the module's single run.

    Parameters:
        tmp_path_factory (pytest.TempPathFactory): pytest temp dirs.
        template_home (Path): session render.

    Returns:
        Sandbox: fresh sandbox.
    """
    return build_sandbox(tmp_path_factory.mktemp("plan-todos"), template_home, local_overrides_from_env())


@pytest.fixture(scope="module")
def run(box: Sandbox) -> RunResult:
    """Plan, approve, then implement: one item proven, then a premature "done".

    Parameters:
        box (Sandbox): module sandbox.

    Returns:
        RunResult: the headless run.
    """
    steps = [
        {"tools": [{"name": "plan_mode_complete", "args": {"plan": PLAN}}]},
        todo(action="list"),
        todo(action="update", id=1, status="completed"),
        todo(action="update", id=1, status="completed", evidence=EVIDENCE),
        {"text": PREMATURE_DONE},
        {"echoLast": True},
    ]
    result = run_headless(
        box,
        {"providers": {"faux": {"models": ["main"], "steps": steps}}},
        ["/plan start", "plan it", "/plan implement"],
    )
    assert result.returncode == 0, result.transcript()
    return result


@pytest.fixture
def batch_run(sandbox: Sandbox) -> RunResult:
    """Approve a plan, then close every plan item in one atomic `ops` batch.

    Parameters:
        sandbox (Sandbox): fresh sandbox for the batch scenario.

    Returns:
        RunResult: the headless run.
    """
    steps = [
        {"tools": [{"name": "plan_mode_complete", "args": {"plan": PLAN}}]},
        todo(
            ops=[
                {"action": "update", "id": 1, "status": "completed", "evidence": BATCH_EVIDENCE},
                {"action": "update", "id": 2, "status": "deferred", "reason": DEFER_REASON},
                {"action": "update", "id": 3, "status": "completed", "evidence": BATCH_EVIDENCE},
            ]
        ),
        todo(action="list"),
    ]
    result = run_headless(
        sandbox,
        {"providers": {"faux": {"models": ["main"], "steps": steps}}},
        ["/plan start", "plan it", "/plan implement"],
    )
    assert result.returncode == 0, result.transcript()
    return result


def test_plan_items_close_in_one_evidenced_batch(batch_run: RunResult) -> None:
    """One `ops` call completes or defers every approved plan item with its required proof."""
    batch, listed = todo_outcomes(batch_run)
    assert batch.args == {
        "ops": [
            {"action": "update", "id": 1, "status": "completed", "evidence": BATCH_EVIDENCE},
            {"action": "update", "id": 2, "status": "deferred", "reason": DEFER_REASON},
            {"action": "update", "id": 3, "status": "completed", "evidence": BATCH_EVIDENCE},
        ]
    }, batch_run.transcript()
    assert not batch.is_error, batch.text
    assert listed.args == {"action": "list"}, batch_run.transcript()
    lines = listed.text.splitlines()
    assert lines[0] == "Plan: Ship widgets -- 0/3 plan items open", listed.text
    assert lines[1:] == [
        "[completed] #1 Add the `alpha` module [plan: Work]",
        f"    evidence: {BATCH_EVIDENCE}",
        "[deferred] #2 Wire `beta` into the CLI [plan: Work]",
        f"    deferred: {DEFER_REASON}",
        "[completed] #3 `make test` passes [plan: Verification]",
        f"    evidence: {BATCH_EVIDENCE}",
    ], listed.text


def test_closed_plan_heading_counts_sum(batch_run: RunResult, sandbox: Sandbox) -> None:
    """The real `/todos` counts account for all three items, matching the closed plan header."""
    assert batch_run.returncode == 0, batch_run.transcript()
    (session,) = list((sandbox.agent_dir / "sessions").rglob("*.jsonl"))
    script = sandbox.root / "heading.json"
    script.write_text(json.dumps({"providers": {"faux": {"models": ["main"], "steps": []}}}))
    with rpc(
        sandbox,
        ["-e", str(FAUX_EXTENSION), "--session", str(session)],
        "faux/main",
        {"HARNESS_SCRIPT": str(script)},
    ) as client:
        client.command("/todos")
        notification = client.wait(
            lambda event: event.get("type") == "extension_ui_request" and event.get("method") == "notify"
        )
        message = notification.get("message", "")
        # Zero counts are omitted by the UI; the two nonzero counts sum to all three items.
        assert message.splitlines()[0] == "2 done, 1 deferred", notification
        assert "Pending" not in message, notification
        assert "In Progress" not in message, notification
        listed = todo_outcomes(batch_run)[-1]
        assert listed.text.splitlines()[0] == "Plan: Ship widgets -- 0/3 plan items open", listed.text


def test_replacement_approval_replaces_unfinished_plan_todos(sandbox: Sandbox) -> None:
    """A replacement stays in planning until approved, then atomically replaces the old plan's items."""
    initial = run_headless(
        sandbox,
        {
            "providers": {
                "faux": {
                    "models": ["main"],
                    "steps": [
                        {"tools": [{"name": "plan_mode_complete", "args": {"plan": PLAN}}]},
                        {"text": "Start the original implementation."},
                    ],
                }
            }
        },
        ["/plan start", "make the original plan", "/plan implement"],
    )
    assert initial.returncode == 0, initial.transcript()
    (session,) = list((sandbox.agent_dir / "sessions").rglob("*.jsonl"))

    replacement = run_headless(
        sandbox,
        {
            "providers": {
                "faux": {
                    "models": ["main"],
                    "steps": [
                        {"tools": [{"name": "plan_mode_complete", "args": {"plan": REPLACEMENT_PLAN}}]},
                        todo(action="list"),
                    ],
                }
            }
        },
        ["/plan start", "replace the plan", "/plan implement"],
        extra_args=["--session", str(session)],
    )
    assert replacement.returncode == 0, replacement.transcript()
    completions = [outcome for outcome in replacement.tool_outcomes() if outcome.name == "plan_mode_complete"]
    assert len(completions) == 1, replacement.transcript()
    assert not completions[0].is_error, replacement.transcript()
    (listed,) = [outcome for outcome in replacement.tool_outcomes() if outcome.args == {"action": "list"}]
    assert listed.text.splitlines() == ["Plan: Ship widgets v2 -- 2/2 plan items open", *REPLACEMENT_ROWS], (
        listed.text
    )


def test_declined_replacement_preserves_old_plan_todos(sandbox: Sandbox) -> None:
    """A declined replacement cannot overwrite old plan items after an unanswered confirmation."""
    initial = run_headless(
        sandbox,
        {
            "providers": {
                "faux": {
                    "models": ["main"],
                    "steps": [
                        {"tools": [{"name": "plan_mode_complete", "args": {"plan": PLAN}}]},
                        {"text": "Start the original implementation."},
                    ],
                }
            }
        },
        ["/plan start", "make the original plan", "/plan implement"],
    )
    assert initial.returncode == 0, initial.transcript()
    (session,) = list((sandbox.agent_dir / "sessions").rglob("*.jsonl"))

    declined = run_headless(
        sandbox,
        {
            "providers": {
                "faux": {
                    "models": ["main"],
                    "steps": [
                        {"tools": [{"name": "plan_mode_complete", "args": {"plan": REPLACEMENT_PLAN}}]},
                        {"tools": [{"name": "plan_mode_question", "args": REPROPOSAL_CONFIRMATION}]},
                        {"tools": [{"name": "plan_mode_complete", "args": {"plan": REPLACEMENT_PLAN}}]},
                    ],
                }
            }
        },
        ["/plan start", "draft a replacement", "no, keep working on the old plan"],
        extra_args=["--session", str(session)],
    )
    assert declined.returncode == 0, declined.transcript()
    (question,) = [outcome for outcome in declined.tool_outcomes() if outcome.name == "plan_mode_question"]
    assert question.args == REPROPOSAL_CONFIRMATION, declined.transcript()
    assert '"mode": "reproposal_confirmation"' in question.text, question.text
    completions = [outcome for outcome in declined.tool_outcomes() if outcome.name == "plan_mode_complete"]
    assert [outcome.is_error for outcome in completions] == [False, True], declined.transcript()

    remaining = run_headless(
        sandbox,
        {"providers": {"faux": {"models": ["main"], "steps": [todo(action="list")]}}},
        ["/plan exit", "list the remaining work"],
        extra_args=["--session", str(session)],
    )
    assert remaining.returncode == 0, remaining.transcript()
    (listed,) = [outcome for outcome in remaining.tool_outcomes() if outcome.args == {"action": "list"}]
    assert listed.text.splitlines() == ["Plan: Ship widgets -- 3/3 plan items open", *PLAN_ROWS], listed.text


def test_replanning_defers_old_reminder_across_compaction_and_restore(sandbox: Sandbox) -> None:
    """Replanning suppresses old-work nudges across compaction, reload, and legacy mode restore."""
    initial = run_headless(
        sandbox,
        {
            "providers": {
                "faux": {
                    "models": ["main"],
                    "steps": [
                        {"tools": [{"name": "plan_mode_complete", "args": {"plan": PLAN}}]},
                        {"text": "Start the original implementation."},
                    ],
                }
            }
        },
        ["/plan start", "make the original plan", "/plan implement"],
    )
    assert initial.returncode == 0, initial.transcript()
    (session,) = list((sandbox.agent_dir / "sessions").rglob("*.jsonl"))

    sandbox.patch_json(
        "settings.json", {"compaction": {"enabled": True, "keepRecentTokens": 1, "reserveTokens": 1}}
    )
    replanning = run_headless(
        sandbox,
        {
            "providers": {
                "faux": {
                    "models": ["main"],
                    "contextWindow": 1,
                    # Compaction can request more than one summary before the ordinary reply.
                    "steps": [{"text": DRAFTING_REPLACEMENT} for _ in range(8)],
                }
            }
        },
        ["/plan start", "draft a replacement"],
        extra_args=["--session", str(session)],
    )
    assert replanning.returncode == 0, replanning.transcript()
    assert replanning.assistant_texts() == [DRAFTING_REPLACEMENT], replanning.transcript()
    compactions = replanning.of_type("compaction_start")
    assert compactions, replanning.transcript()
    assert replanning.of_type("compaction_end")[-1].get("result"), replanning.transcript()

    sandbox.patch_json("settings.json", {"compaction": {"enabled": False}})
    exited = run_headless(
        sandbox,
        {
            "providers": {
                "faux": {"models": ["main"], "steps": [{"text": CONTINUE_OLD_PLAN}, {"echoLast": True}]}
            }
        },
        ["/plan exit", "continue the original work"],
        extra_args=["--session", str(session)],
    )
    assert exited.returncode == 0, exited.transcript()
    texts = exited.assistant_texts()
    assert texts[0] == CONTINUE_OLD_PLAN, exited.transcript()
    assert texts[1].startswith("ECHO Plan check:"), exited.transcript()
    assert 'the approved plan "Ship widgets" still has 3/3 items open' in texts[1], texts[1]

    listed = run_headless(
        sandbox,
        {"providers": {"faux": {"models": ["main"], "steps": [todo(action="list")]}}},
        ["list the remaining work"],
        extra_args=["--session", str(session)],
    )
    assert listed.returncode == 0, listed.transcript()
    (outcome,) = [outcome for outcome in todo_outcomes(listed) if outcome.args == {"action": "list"}]
    assert outcome.text.splitlines() == ["Plan: Ship widgets -- 3/3 plan items open", *PLAN_ROWS], (
        outcome.text
    )

    append_legacy_plan_mode_state(session, True)
    legacy_planning = run_headless(
        sandbox,
        {"providers": {"faux": {"models": ["main"], "steps": [{"text": DRAFTING_REPLACEMENT}]}}},
        ["continue replanning from a legacy session"],
        extra_args=["--session", str(session)],
    )
    assert legacy_planning.returncode == 0, legacy_planning.transcript()
    assert legacy_planning.assistant_texts() == [DRAFTING_REPLACEMENT], legacy_planning.transcript()

    append_legacy_plan_mode_state(session, False)
    legacy_normal = run_headless(
        sandbox,
        {
            "providers": {
                "faux": {"models": ["main"], "steps": [{"text": CONTINUE_OLD_PLAN}, {"echoLast": True}]}
            }
        },
        ["continue the original work after legacy restore"],
        extra_args=["--session", str(session)],
    )
    assert legacy_normal.returncode == 0, legacy_normal.transcript()
    assert legacy_normal.assistant_texts()[0] == CONTINUE_OLD_PLAN, legacy_normal.transcript()
    assert legacy_normal.assistant_texts()[1].startswith("ECHO Plan check:"), legacy_normal.transcript()


def todo_outcomes(result: RunResult) -> list[ToolOutcome]:
    """Settled `todo` calls in order.

    Parameters:
        result (RunResult): headless run.

    Returns:
        list[ToolOutcome]: one per `todo` call.
    """
    return [outcome for outcome in result.tool_outcomes() if outcome.name == "todo"]


def test_plan_items_are_seeded_verbatim(run: RunResult) -> None:
    """The approved plan's bullets are the todo list, word for word, before the agent writes any."""
    listed = todo_outcomes(run)[0]
    assert listed.args == {"action": "list"}, run.transcript()
    lines = listed.text.splitlines()
    assert lines[0] == "Plan: Ship widgets -- 3/3 plan items open", listed.text
    assert lines[1:] == PLAN_ROWS, listed.text


def test_completed_requires_evidence(run: RunResult) -> None:
    """A bare `completed` is refused; the same update with evidence goes through."""
    _, bare, proven = todo_outcomes(run)
    assert bare.text.startswith("Error: evidence required to mark a task completed"), bare.text
    assert proven.text == "Updated #1 (pending → completed)", proven.text


def session_entries(box: Sandbox) -> list[dict[str, Any]]:
    """Every entry of every session the sandbox wrote.

    Parameters:
        box (Sandbox): sandbox of the run.

    Returns:
        list[dict[str, Any]]: parsed jsonl lines.
    """
    return [
        json.loads(line)
        for path in sorted((box.agent_dir / "sessions").rglob("*.jsonl"))
        for line in path.read_text().splitlines()
        if line.strip()
    ]


def test_ending_with_open_items_reminds_once(run: RunResult, box: Sandbox) -> None:
    """The premature "done" gets one more turn whose context lists exactly the open items."""
    texts = run.assistant_texts()
    assert PREMATURE_DONE in texts, run.transcript()
    after = texts[texts.index(PREMATURE_DONE) + 1 :]
    assert len(after) == 1, f"expected exactly one reminder turn, got {after}\n{run.transcript()}"
    reminder = after[0]
    assert reminder.startswith("ECHO Plan check:"), run.transcript()
    assert 'the approved plan "Ship widgets" still has 2/3 items open' in reminder, reminder
    assert "Do not tell the user the work is done." in reminder, reminder
    assert "- #2 [Work] Wire `beta` into the CLI" in reminder, reminder
    assert "- #3 [Verification] `make test` passes" in reminder, reminder
    assert "#1 " not in reminder, reminder

    # Only the short hidden marker is persisted; the item list was request-local.
    markers = [entry for entry in session_entries(box) if entry.get("customType") == REMINDER_TYPE]
    assert len(markers) == 1, markers
    assert markers[0]["content"] == REMINDER_MARKER, markers[0]
    assert markers[0]["display"] is False, markers[0]
