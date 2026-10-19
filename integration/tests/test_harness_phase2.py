"""Unit tests for the session generator, multi-metric bench, and live-tier helpers."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from harness import bench, live
from harness.headless import RunResult
from harness.sandbox import Sandbox
from harness.sessions import MESSAGES_PER_TURN, write_session

if TYPE_CHECKING:
    from pathlib import Path


def make_box(root: Path) -> Sandbox:
    """Build a bare sandbox layout without installing packages.

    Parameters:
        root (Path): scratch dir.

    Returns:
        Sandbox: sandbox with an empty agent dir and a fake `auth.json`.
    """
    home = root / "home"
    agent_dir = home / ".pi" / "agent"
    agent_dir.mkdir(parents=True)
    (agent_dir / "auth.json").write_text("{}")
    return Sandbox(root=root, home=home, agent_dir=agent_dir, workdir=root)


def assistant_event(cost: float) -> dict[str, Any]:
    """One assistant `message_end` event with a given cost.

    Parameters:
        cost (float): `usage.cost.total`.

    Returns:
        dict[str, Any]: event.
    """
    return {"type": "message_end", "message": {"role": "assistant", "usage": {"cost": {"total": cost}}}}


def run_with(events: list[dict[str, Any]]) -> RunResult:
    """Wrap events in a finished `RunResult`.

    Parameters:
        events (list[dict[str, Any]]): JSON events.

    Returns:
        RunResult: result with exit 0.
    """
    return RunResult(argv=["pi"], returncode=0, events=events, stdout_noise=[], stderr="", duration_s=0.0)


def test_write_session_chains_every_message(tmp_path: Path) -> None:
    path = tmp_path / "s.jsonl"
    turns = write_session(path, tmp_path, 8)
    entries = [json.loads(line) for line in path.read_text().splitlines()]
    assert turns == 2
    assert entries[0]["type"] == "session"
    assert entries[0]["cwd"] == str(tmp_path)
    messages = entries[1:]
    assert len(messages) == 8
    assert [entry["parentId"] for entry in messages] == [None, *(entry["id"] for entry in messages[:-1])]
    assert [entry["message"]["role"] for entry in messages[:MESSAGES_PER_TURN]] == [
        "user",
        "assistant",
        "toolResult",
        "assistant",
    ]
    assert messages[2]["message"]["toolCallId"] == messages[1]["message"]["content"][0]["id"]


@pytest.mark.parametrize("count", [0, 6, -4])
def test_write_session_rejects_partial_turns(tmp_path: Path, count: int) -> None:
    with pytest.raises(ValueError, match="multiple of 4"):
        write_session(tmp_path / "s.jsonl", tmp_path, count)


def test_measure_many_takes_per_metric_medians() -> None:
    runs = iter([{"a": 1.0, "b": 30.0}, {"a": 3.0, "b": 10.0}, {"a": 2.0, "b": 20.0}])
    assert bench.measure_many(lambda: next(runs), samples=3) == {"a": 2.0, "b": 20.0}


def test_measure_many_rejects_inconsistent_metrics() -> None:
    runs = iter([{"a": 1.0}, {"b": 1.0}])
    with pytest.raises(ValueError, match="different metrics"):
        bench.measure_many(lambda: next(runs), samples=2)
    with pytest.raises(ValueError, match="positive"):
        bench.measure_many(lambda: {"a": 1.0}, samples=0)


def test_ledger_charges_the_larger_source_and_enforces_the_cap(tmp_path: Path) -> None:
    box = make_box(tmp_path)
    child = box.agent_dir / "sessions" / "child.jsonl"
    child.parent.mkdir()
    child.write_text(
        "\n".join(
            json.dumps({"type": "message", "message": message})
            for message in [
                {"role": "assistant", "usage": {"cost": {"total": 0.10}}},
                {"role": "user", "usage": {"cost": {"total": 9.0}}},
            ]
        )
        + "\nnot json\n"
    )
    ledger = live.CostLedger(cap_usd=0.25)
    assert ledger.charge("a", run_with([assistant_event(0.04)]), box) == pytest.approx(0.10)
    ledger.require_headroom()
    child.unlink()
    with pytest.raises(AssertionError, match=r"passed the \$0\.25 cap"):
        ledger.charge("b", run_with([assistant_event(0.2)]), box)
    with pytest.raises(AssertionError, match="reached"):
        ledger.require_headroom()


def test_link_real_credentials_symlinks_never_copies(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    real_agent = tmp_path / "real" / ".pi" / "agent"
    real_agent.mkdir(parents=True)
    (real_agent / "auth.json").write_text('{"secret": 1}')
    monkeypatch.setenv("HARNESS_AUTH_FILE", str(real_agent / "auth.json"))
    box = make_box(tmp_path / "box")

    live.link_real_credentials(box)

    auth = box.agent_dir / "auth.json"
    assert auth.is_symlink()
    assert auth.resolve() == (real_agent / "auth.json").resolve()
    assert not (box.home / ".claude").exists()


def test_link_real_credentials_requires_real_auth(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HARNESS_AUTH_FILE", str(tmp_path / "missing"))
    with pytest.raises(FileNotFoundError, match="No real credentials"):
        live.link_real_credentials(make_box(tmp_path / "box"))


def test_live_credentials_have_no_default_discovery(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("HARNESS_AUTH_FILE", raising=False)
    with pytest.raises(ValueError, match="explicit `HARNESS_AUTH_FILE`"):
        live.link_real_credentials(make_box(tmp_path / "box"))


def test_live_enabled_reads_the_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(live.LIVE_ENV, raising=False)
    assert not live.live_enabled()
    monkeypatch.setenv(live.LIVE_ENV, "1")
    assert live.live_enabled()
