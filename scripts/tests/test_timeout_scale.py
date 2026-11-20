"""Check opt-in deadlines at the subprocess boundary.

References:
    https://docs.python.org/3/library/subprocess.html#subprocess.run
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import native_lint
import package_contracts as pc


@pytest.mark.parametrize(("scale", "expected"), [(None, 300), ("3", 900), ("1.5", 450), ("11", 3000)])
def test_native_tool_deadline(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, scale: str | None, expected: int
) -> None:
    """Pass the default, fractional, or capped deadline to the native subprocess."""
    if scale is None:
        monkeypatch.delenv("PI_TIMEOUT_SCALE", raising=False)
    else:
        monkeypatch.setenv("PI_TIMEOUT_SCALE", scale)
    run = Mock(return_value=subprocess.CompletedProcess([], 0, stdout="ok"))
    monkeypatch.setattr(subprocess, "run", run)

    assert native_lint.run(["/tool"], tmp_path) == "ok"
    assert run.call_args.kwargs["timeout"] == expected


@pytest.mark.parametrize("scale", ["", "slow", "0.99", "nan", "inf"])
def test_invalid_scale_never_launches_native_tool(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, scale: str
) -> None:
    """Reject malformed, below-minimum and nonfinite inputs before shelling out."""
    monkeypatch.setenv("PI_TIMEOUT_SCALE", scale)
    run = Mock(return_value=subprocess.CompletedProcess([], 0, stdout="ok"))
    monkeypatch.setattr(subprocess, "run", run)

    with pytest.raises(ValueError, match=r"`PI_TIMEOUT_SCALE` must be a finite number >= 1"):
        native_lint.run(["/tool"], tmp_path)
    run.assert_not_called()


@pytest.mark.parametrize(("scale", "expected"), [(None, 300), ("3", 900)])
def test_npm_deadlines(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, scale: str | None, expected: int
) -> None:
    """Pass the multiplier through preview, build, pack, install and registry calls."""
    if scale is None:
        monkeypatch.delenv("PI_TIMEOUT_SCALE", raising=False)
    else:
        monkeypatch.setenv("PI_TIMEOUT_SCALE", scale)
    npm = tmp_path / "npm"
    sandbox = pc.Sandbox(tmp_path / "sandbox", pc.Tools(npm, npm, npm))
    contract = pc.COMPUTER_USE_CONTRACT
    artifact = pc.PackedArtifact(contract, tmp_path / "x.tgz", "1.0.0", "sha512-x", "0" * 40, 1, ())
    preview = json.dumps(
        [
            {
                "filename": "x.tgz",
                "integrity": "sha512-" + "A" * 86 + "==",
                "shasum": "0" * 40,
                "files": [{"path": "package.json"}],
            }
        ]
    )
    timed_out = subprocess.TimeoutExpired(str(npm), expected)
    run = Mock(
        side_effect=[
            subprocess.CompletedProcess([], 0, stdout=preview),
            subprocess.CompletedProcess([], 0, stdout=""),
            timed_out,
            timed_out,
            timed_out,
            timed_out,
        ]
    )
    monkeypatch.setattr(subprocess, "run", run)

    with pytest.raises(pc.ContractError, match="timed out"):
        pc.pack(contract, tmp_path, sandbox, tmp_path)
    with pytest.raises(pc.ContractError, match="timed out"):
        pc.ensure_stock_pi(tmp_path / "stock", sandbox)
    with pytest.raises(pc.ContractError, match="timed out"):
        pc.install_alone(artifact, sandbox, tmp_path / "project")
    with pytest.raises(pc.ContractError, match="timed out"):
        pc.published_sampler_dist(sandbox, tmp_path)
    assert [(call.args[0][1], call.kwargs["timeout"]) for call in run.call_args_list] == [
        ("pack", expected),
        ("run", expected),
        ("pack", expected),
        ("install", expected),
        ("install", expected),
        ("view", expected),
    ]
