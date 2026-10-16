"""Unit tests for the harness library itself."""

from __future__ import annotations

import json
import os
import re
import subprocess
from typing import TYPE_CHECKING

import pytest

from harness import bench, golden
from harness.config_checks import brewfile_pin, formula_version, git_pins, schema_settings_keys, settings_keys
from harness.paths import FAUX_EXTENSION, pi_command
from harness.sandbox import (
    deep_merge,
    local_overrides_from_env,
    with_local_npm_packages,
    without_excluded_packages,
)
from harness.tmux import reap_stale_servers, sgr_mouse, strip_ansi
from harness.transcript import collapsed_entries, entry_key, one_line_violations, transcript_region

if TYPE_CHECKING:
    from pathlib import Path

SETTINGS_TS = """
import x from "y";
export interface Settings {
\tlastChangelogVersion?: string;
\tcompaction?: {
\t\tenabled?: boolean;
\t\tnested?: { deep?: number };
\t};
\treadonly quietStartup?: boolean | "header";
\t"quoted-key"?: string;
}
export interface Other { notMe?: string; }
"""


def test_settings_keys_reads_only_top_level_members() -> None:
    assert settings_keys(SETTINGS_TS) == {"lastChangelogVersion", "compaction", "quietStartup", "quoted-key"}


def test_settings_keys_rejects_missing_interface() -> None:
    with pytest.raises(ValueError, match="No `export interface Settings"):
        settings_keys("export interface Nope {}")


def test_schema_settings_keys_reads_compiled_schema(tmp_path: Path) -> None:
    schema = tmp_path / "settings-schema.js"
    schema.write_text(
        "export const SettingsSchema = { properties: { theme: {}, compaction: {}, retry: {} } };\n"
    )
    assert schema_settings_keys(schema) == {"theme", "compaction", "retry"}


def test_schema_settings_keys_rejects_missing_schema(tmp_path: Path) -> None:
    schema = tmp_path / "settings-schema.js"
    schema.write_text("export const Other = {};\n")
    with pytest.raises(ValueError, match="declares no properties"):
        schema_settings_keys(schema)


def test_git_pins_parses_strings_and_objects() -> None:
    pins = git_pins(
        [
            "npm:pi-memory",
            "git:github.com/nredd/pi-subagents@v0.19.0-nredd.10",
            {"source": "git:github.com/nredd/rpiv-todo@v2.12.0-nredd.1"},
            "git:github.com/nredd/unpinned",
            42,
        ]
    )
    assert [(pin.repo, pin.ref) for pin in pins] == [
        ("pi-subagents", "v0.19.0-nredd.10"),
        ("rpiv-todo", "v2.12.0-nredd.1"),
    ]


def test_brew_pin_chain_parsers() -> None:
    assert brewfile_pin('tap "x"\n# pinned: v1.0.0-nredd.1\nbrew "y"\n') == "v1.0.0-nredd.1"
    assert formula_version('class Pi < Formula\n  version "1.0.0-nredd.1"\nend\n') == "1.0.0-nredd.1"
    with pytest.raises(ValueError, match="Expected one"):
        brewfile_pin("# pinned: a\n# pinned: b\n")
    with pytest.raises(ValueError, match="no explicit"):
        formula_version("class Pi < Formula\nend\n")


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


def test_local_overrides_default_to_code_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HARNESS_LOCAL", f"pi-subagents, pi-plan-mode={tmp_path}")
    overrides = local_overrides_from_env()
    assert overrides["pi-subagents"].name == "pi-subagents"
    assert overrides["pi-plan-mode"] == tmp_path.resolve()


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
    """A blank gutter is valid only at an entry boundary, and must not hide multiline output."""
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
    old = tmp_path / "pih-old"
    fresh = tmp_path / "pih-fresh"
    other = tmp_path / "unrelated"
    for directory in (old, fresh, other):
        directory.mkdir()
    os.utime(old, (0, 0))
    os.utime(other, (0, 0))
    assert reap_stale_servers(tmp_path, max_age_s=3600) == [old]
    assert not old.exists()
    assert fresh.exists()
    assert other.exists()


FAUX_ROW = re.compile(r"^faux\s+main\b", re.MULTILINE)


def test_faux_extension_loads_in_pi(tmp_path: Path) -> None:
    """`providers/faux.ts` loads through pi's own extension loader and registers `faux/main`.

    A syntax slip there breaks every scenario at once; this catches it in the unit tier.
    """
    completed = subprocess.run(
        [*pi_command(), "--no-extensions", "-e", str(FAUX_EXTENSION), "--list-models", "faux"],
        env=os.environ | {"PI_CODING_AGENT_DIR": str(tmp_path), "PI_OFFLINE": "1", "HARNESS_SCRIPT": ""},
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    output = completed.stdout + completed.stderr
    assert "Failed to load extension" not in output, output
    assert FAUX_ROW.search(completed.stdout), output


def test_sandbox_drops_computer_use() -> None:
    packages = [
        "npm:pi-memory",
        "npm:@injaneity/pi-computer-use@0.5.1",
        {"source": "npm:@injaneity/pi-computer-use"},
        "git:github.com/nredd/pi-computer-use@v0.5.1-nredd.1",
        "https://github.com/nredd/pi-computer-use.git",
        "git:git@github.com:nredd/pi-computer-use",
        "~/code/pi-computer-use",
        "npm:pi-computer-use-extras@1.0.0",
        "git:github.com/nredd/pi-plan-mode@v0.58.3-nredd.7",
    ]
    assert without_excluded_packages(packages) == [
        "npm:pi-memory",
        "npm:pi-computer-use-extras@1.0.0",
        "git:github.com/nredd/pi-plan-mode@v0.58.3-nredd.7",
    ]


def test_local_npm_packages_swap_only_the_named_package(tmp_path: Path) -> None:
    packages = [
        "npm:pi-memory",
        "npm:pi-claude-auth",
        {"source": "npm:pi-claude-auth@0.1.3", "extensions": ["x"]},
        "npm:@scope/pi-claude-auth",
        "git:github.com/nredd/pi-subagents@abc",
    ]
    overrides = {"pi-claude-auth": tmp_path, "pi-memory": tmp_path / "ignored", "pi-subagents": tmp_path}
    assert with_local_npm_packages(packages, overrides) == [
        "npm:pi-memory",
        str(tmp_path),
        {"source": str(tmp_path), "extensions": ["x"]},
        "npm:@scope/pi-claude-auth",
        "git:github.com/nredd/pi-subagents@abc",
    ]
    assert with_local_npm_packages(packages, {}) == packages


def test_local_npm_packages_require_the_checkout(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="pi-claude-auth"):
        with_local_npm_packages(["npm:pi-claude-auth"], {"pi-claude-auth": tmp_path / "missing"})
