"""Exercise per-OS coverage floors with real LCOV and committed base policies.

References:
    ../../docs/coverage.md
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_accounting import Counts, Policy, account, check_ratchet
from tests.test_coverage_accounting import SCRIPT, policy, setup_report
from tests.test_coverage_round2 import commit_base


@pytest.mark.parametrize("runner_os", ["darwin", "linux"])
@pytest.mark.parametrize("fixture", ["uncovered.info", "function-only.info", "line-only.info"])
def test_platform_floor_selection(tmp_path: Path, runner_os: str, fixture: str) -> None:
    """Select only the running platform's budget for independent counters.

    Parameters:
        tmp_path (Path): Disposable source/report root.
        runner_os (str): Platform whose budget is relaxed to the real measurement.
        fixture (str): Real LCOV with independently uncovered lines/functions.
    Returns:
        None: Matching floors pass, and the other platform's zero budget fails.
    Raises:
        AssertionError: Accounting uses the other OS's floor or merges them.
    """
    setup_report(tmp_path, fixture)
    cfg = policy()
    cfg.packages["example"].signals["primary"].max_uncovered[runner_os] = Counts(lines=1, functions=1)
    results, errors = account(tmp_path, cfg, runner_os)
    assert not errors
    assert results[0]["os"] == runner_os
    other = "linux" if runner_os == "darwin" else "darwin"
    assert "Budget exceeded" in account(tmp_path, cfg, other)[1][0]


@pytest.mark.parametrize("runner_os", ["darwin", "linux"])
@pytest.mark.parametrize("enforce_target", [False, True])
def test_missing_platform_floor_fails_closed(tmp_path: Path, runner_os: str, enforce_target: bool) -> None:
    """Never fall back to another OS or even the global zero target.

    Parameters:
        tmp_path (Path): Disposable passing LCOV fixture root.
        runner_os (str): Platform whose declaration is missing.
        enforce_target (bool): Whether the final primary target is enabled.
    Returns:
        None: Missing OS membership fails despite fully covered LCOV.
    Raises:
        AssertionError: Accounting invents a default for an unmeasured OS.
    """
    setup_report(tmp_path)
    cfg = policy()
    cfg.enforce_target = enforce_target
    del cfg.packages["example"].signals["primary"].max_uncovered[runner_os]
    assert account(tmp_path, cfg, runner_os)[1] == [f"example/primary: Missing OS floor: '{runner_os}'"]


@pytest.mark.parametrize("runner_os", ["darwin", "linux"])
@pytest.mark.parametrize("metric", ["lines", "functions"])
def test_base_ratchet_checks_every_os(tmp_path: Path, runner_os: str, metric: str) -> None:
    """Ratchet both OSes against a real Git base, not just the selected runner.

    Parameters:
        tmp_path (Path): Disposable Git/source/report root with real LCOV.
        runner_os (str): OS whose committed floor is changed.
        metric (str): Independent uncovered counter to raise or lower.
    Returns:
        None: Raising either OS fails on both runners; lowering passes on both.
    Raises:
        AssertionError: A nonrunning platform's increased floor bypasses the base.
    """
    setup_report(tmp_path)
    base = policy()
    for floor in base.packages["example"].signals["primary"].max_uncovered.values():
        floor.lines = 1
        floor.functions = 1
    commit_base(tmp_path, base)
    current = base.model_copy(deep=True)
    floor = current.packages["example"].signals["primary"].max_uncovered[runner_os]
    for value, expected in [(2, 1), (0, 0)]:
        setattr(floor, metric, value)
        (tmp_path / "coverage/policy.json").write_text(current.model_dump_json())
        for selected in ["darwin", "linux"]:
            summary = tmp_path / "summary.json"
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--root",
                    str(tmp_path),
                    "--base",
                    "HEAD",
                    "--os",
                    selected,
                    "--summary",
                    str(summary),
                ],
                capture_output=True,
                check=False,
            )
            assert result.returncode == expected, result.stderr.decode()
            errors = json.loads(summary.read_text())["errors"]
            if expected:
                assert f"example/primary/{runner_os}" in errors[0]
            else:
                assert not errors


@pytest.mark.parametrize("runner_os", ["darwin", "linux"])
def test_base_os_floor_cannot_disappear(tmp_path: Path, runner_os: str) -> None:
    """Require every previously declared OS even when this host uses another.

    Parameters:
        tmp_path (Path): Disposable fully covered LCOV/source root.
        runner_os (str): Previously measured OS to remove.
    Returns:
        None: Valid LCOV cannot authorize losing a base OS floor.
    Raises:
        AssertionError: Removing an existing OS declaration bypasses ratcheting.
    """
    setup_report(tmp_path)
    base = policy()
    assert not account(tmp_path, base, runner_os)[1]
    current = base.model_copy(deep=True)
    del current.packages["example"].signals["primary"].max_uncovered[runner_os]
    with pytest.raises(ValueError, match=f"Missing OS floor: 'example/primary/{runner_os}'"):
        check_ratchet(current, base)


def test_enabled_global_target_cannot_be_disabled(tmp_path: Path) -> None:
    """Reject base-enabled/current-disabled even with passing real LCOV.

    Parameters:
        tmp_path (Path): Disposable fully covered LCOV/source root.
    Returns:
        None: Disabling the already-enabled global target fails the base ratchet.
    Raises:
        AssertionError: The global target can be weakened after activation.
    """
    setup_report(tmp_path)
    base = policy()
    base.enforce_target = True
    current = base.model_copy(deep=True)
    current.enforce_target = False
    assert not account(tmp_path, current)[1]
    with pytest.raises(ValueError, match="Cannot disable global target"):
        check_ratchet(current, base)
    check_ratchet(base, current)


@pytest.mark.parametrize("runner_os", ["darwin", "linux"])
def test_measure_artifacts_prints_reviewable_diff_without_writing_policy(
    tmp_path: Path, runner_os: str
) -> None:
    """Regenerate measured floors from separate artifacts, never mutate policy.

    Parameters:
        tmp_path (Path): Disposable checkout and downloaded-artifact roots.
        runner_os (str): Explicit platform bound to this artifact measurement.
    Returns:
        None: JSON counts and the review diff reflect real LCOV without a hidden ratchet bypass.
    Raises:
        AssertionError: Measurement changes the policy or silently behaves as a gate.
    """
    root = tmp_path / "repo"
    root.mkdir()
    report = setup_report(root, "uncovered.info")
    cfg = policy()
    commit_base(root, cfg)
    artifact = tmp_path / "artifact"
    destination = artifact / report.relative_to(root)
    destination.parent.mkdir(parents=True)
    report.rename(destination)
    policy_path = root / "coverage/policy.json"
    before = policy_path.read_bytes()
    summary = tmp_path / "measurement.json"
    argv = [
        sys.executable,
        str(SCRIPT),
        "--root",
        str(root),
        "--measure",
        "--os",
        runner_os,
        "--reports-root",
        str(artifact),
        "--summary",
        str(summary),
    ]
    result = subprocess.run(argv, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr.decode()
    measured = json.loads(summary.read_text())
    assert measured["measurement_only"] is True
    assert measured["measured_floors"] == {"example/primary": {runner_os: {"lines": 1, "functions": 1}}}
    assert b"MEASUREMENT ONLY" in result.stderr
    assert f"+++ measured/{runner_os}/policy.json" in result.stderr.decode()
    assert policy_path.read_bytes() == before
    invalid = subprocess.run([*argv, "--base", "HEAD"], capture_output=True, check=False)
    assert invalid.returncode == 2
    destination.unlink()
    missing = subprocess.run(argv, capture_output=True, check=False)
    assert missing.returncode == 1
    assert b"MEASUREMENT ONLY" not in missing.stderr


def test_unmeasured_platforms_are_not_invented(tmp_path: Path) -> None:
    """Keep Windows and unsupported platform names outside the measured schema.

    Parameters:
        tmp_path (Path): Disposable real LCOV/source root.
    Returns:
        None: Schema and accounting both reject unsupported platform identities.
    Raises:
        AssertionError: An unmeasured OS can be represented as passing coverage.
    """
    setup_report(tmp_path)
    cfg = policy()
    data = cfg.model_dump()
    data["packages"]["example"]["signals"]["primary"]["max_uncovered"]["win32"] = {"lines": 0, "functions": 0}
    with pytest.raises(ValidationError):
        Policy.model_validate(data)
    with pytest.raises(ValueError, match="not measured on OS"):
        account(tmp_path, cfg, "win32")
