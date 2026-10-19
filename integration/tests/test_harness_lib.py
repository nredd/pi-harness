"""Unit tests of surviving terminal, merge, golden and baseline infrastructure."""

from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING

import pytest

from harness import bench, golden
from harness.sandbox import deep_merge
from harness.tmux import reap_stale_servers, sgr_mouse, strip_ansi
from harness.transcript import collapsed_entries, entry_key, one_line_violations, transcript_region

if TYPE_CHECKING:
    from pathlib import Path


def test_sgr_mouse_is_one_based() -> None:
    assert sgr_mouse(0, 0, 0) == b"\x1b[<0;1;1M"
    assert sgr_mouse(64 | 8, 9, 4, release=True) == b"\x1b[<72;10;5m"
    with pytest.raises(ValueError, match="non-negative"):
        sgr_mouse(0, -1, 0)


def test_strip_ansi_removes_csi_and_osc8() -> None:
    styled = "\x1b[1;38;2;1;2;3mbold\x1b[0m \x1b]8;;https://x\x07link\x1b]8;;\x07"
    assert strip_ansi(styled) == "bold link"


def test_deep_merge_recurses_and_overrides() -> None:
    assert deep_merge({"a": {"b": 1, "c": 2}, "d": [1]}, {"a": {"c": 3}, "d": [2]}) == {
        "a": {"b": 1, "c": 3},
        "d": [2],
    }


def test_golden_round_trip(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(golden, "GOLDEN_DIR", tmp_path)
    with pytest.raises(AssertionError, match="Missing golden"):
        golden.assert_golden("x.txt", "a\n")
    monkeypatch.setenv("UPDATE_GOLDEN", "1")
    golden.assert_golden("x.txt", "a\n")
    monkeypatch.delenv("UPDATE_GOLDEN")
    golden.assert_golden("x.txt", "a\n")
    with pytest.raises(AssertionError, match=r"\+b"):
        golden.assert_golden("x.txt", "b\n")


def test_bench_threshold(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    path = tmp_path / "bench.json"
    monkeypatch.setattr(bench, "BASELINES_PATH", path)
    with pytest.raises(AssertionError, match="No baseline"):
        bench.check_against_baseline("m", 1.0)
    monkeypatch.setenv("UPDATE_BASELINES", "1")
    bench.check_against_baseline("m", 1.0)
    monkeypatch.delenv("UPDATE_BASELINES")
    recorded = json.loads(path.read_text())
    assert recorded["m"] == 1.0
    assert set(recorded["_meta"]) == {"wsl", "cpus"}
    bench.check_against_baseline("m", 1.19)
    with pytest.raises(AssertionError, match="regressed"):
        bench.check_against_baseline("m", 1.25)
    assert bench.measure(iter([3.0, 1.0, 2.0]).__next__, samples=3) == 2.0


def test_transcript_invariant() -> None:
    rows = [
        "header",
        " go",
        "┄" * 40,
        "▸  $ ls · 3 lines output",
        "┄" * 40,
        "▸  read x.txt",
        "   leaked line",
        "",
        "▾  edit x.txt",
        "┄" * 40,
        "stray output",
        "DONE",
        "─" * 40,
    ]
    start, end = transcript_region(rows, r"^\s*go\s*$")
    assert (start, end) == (2, 12)
    problems = one_line_violations(rows, start, end, [r"^DONE$"])
    assert len(problems) == 4
    assert "spills" in problems[0]
    assert "outside" in problems[1]
    assert "expanded by default" in problems[2]
    assert [entry.key for entry in collapsed_entries(rows, start, end)] == ["$ ls", "read x.txt"]
    assert entry_key("▾  $ ls") == "$ ls"
    assert transcript_region([*rows[:-1], "▾ ● Todos (0/1)", "─" * 40], r"^\s*go\s*$", r"^DONE$") == (2, 12)
    with pytest.raises(AssertionError, match="Editor rule"):
        transcript_region(rows[:-1], r"^\s*go\s*$")


def test_transcript_static_entries_stay_one_line() -> None:
    rule = "┄" * 40
    valid = [rule, "  todo ≡ 4 ops · ✓", rule, "▸ read notes.txt · alpha", rule]
    assert one_line_violations(valid, 0, len(valid), []) == []
    assert [entry.key for entry in collapsed_entries(valid, 0, len(valid))] == ["read notes.txt"]
    leaked = [rule, "  todo ≡ 4 ops", "  ✓", rule]
    problems = one_line_violations(leaked, 0, len(leaked), [])
    assert len(problems) == 2
    assert "spills" in problems[0]
    assert "outside" in problems[1]


def test_reap_stale_servers_spares_fresh_dirs(tmp_path: Path) -> None:
    old, fresh, other = (tmp_path / name for name in ("pih-old", "pih-fresh", "unrelated"))
    for directory in (old, fresh, other):
        directory.mkdir()
    os.utime(old, (0, 0))
    os.utime(other, (0, 0))
    assert reap_stale_servers(tmp_path, max_age_s=3600) == [old]
    assert not old.exists()
    assert fresh.exists()
    assert other.exists()
