"""Exercise promotion's selected-commit boundary across old and relocated trees.

References:
- https://github.com/nredd/pi-harness/issues/884
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from pi_release import promotion_verify
from pi_release.promotion import EvidenceError, StackSnapshot
from pydantic import ValidationError

from harness.git_fixture import git
from tests.test_promotion_verify import candidate_context, owned_evidence

ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.parametrize("layouts", [("integration",), ("release",), ("integration", "release")])
def test_candidate_uses_one_selected_commit_layout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, layouts: tuple[str, ...]
) -> None:
    """Select new over old, and read stack plus runtime locks from that same tree.

    Parameters:
        tmp_path (Path): disposable git repository and output.
        monkeypatch (pytest.MonkeyPatch): replace external evidence/acquisition only.
        layouts (tuple[str, ...]): source layouts present in the selected commit.
    """
    real_run = promotion_verify.run_command
    ctx, _ = candidate_context(tmp_path, monkeypatch, owned_evidence)
    git(tmp_path, "init")
    for layout in layouts:
        directory = tmp_path / layout / "stacks"
        directory.mkdir(parents=True)
        for name in ("personal.json", "runtime-locks.json"):
            (directory / name).write_bytes((ROOT / "release/stacks" / name).read_bytes())
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "Fixture source layout")
    selected = git(tmp_path, "rev-parse", "HEAD").strip()
    # The working tree is deliberately unrelated to the selected commit.
    for layout in layouts:
        (tmp_path / layout / "stacks/personal.json").write_text("malformed working tree")
    calls: list[tuple[str, ...]] = []

    def run(*args: str, **kwargs: Any) -> Any:
        """Record real git reads without replacing selected-source behavior.

        Parameters:
            *args (str): actual command arguments.
            **kwargs (Any): command options.
        Returns:
            Any: real completed command.
        """
        calls.append(args)
        return real_run(*args, **kwargs)

    monkeypatch.setattr(promotion_verify, "run_command", run)
    promotion_verify.build_candidate(ctx, selected)
    snapshot = StackSnapshot.model_validate_json((ctx.promo / "stack-snapshot.json").read_bytes())
    assert snapshot.source_sha == selected
    directory = "release" if "release" in layouts else "integration"
    reads = [args[-1] for args in calls if "show" in args]
    assert reads == [
        f"{selected}:{directory}/stacks/personal.json",
        f"{selected}:{directory}/stacks/runtime-locks.json",
    ]


@pytest.mark.parametrize("failure", ["malformed-stack", "malformed-lock", "missing-lock"])
def test_candidate_never_falls_back_after_selecting_new_layout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    """A malformed or incomplete new source cannot borrow an old stack or lock.

    Parameters:
        tmp_path (Path): disposable git repository and output.
        monkeypatch (pytest.MonkeyPatch): replace external evidence/acquisition only.
        failure (str): invalid new-layout content.
    """
    real_run = promotion_verify.run_command
    ctx, _ = candidate_context(tmp_path, monkeypatch, owned_evidence)
    git(tmp_path, "init")
    for layout in ("integration", "release"):
        directory = tmp_path / layout / "stacks"
        directory.mkdir(parents=True)
        for name in ("personal.json", "runtime-locks.json"):
            (directory / name).write_bytes((ROOT / "release/stacks" / name).read_bytes())
    directory = tmp_path / "release/stacks"
    if failure == "missing-lock":
        (directory / "runtime-locks.json").unlink()
    else:
        name = "personal.json" if failure == "malformed-stack" else "runtime-locks.json"
        (directory / name).write_text("malformed selected source")
    git(tmp_path, "add", ".")
    git(tmp_path, "commit", "-m", "Fixture invalid source layout")
    selected = git(tmp_path, "rev-parse", "HEAD").strip()
    monkeypatch.setattr(promotion_verify, "run_command", real_run)
    with pytest.raises((ValidationError, EvidenceError)):
        promotion_verify.build_candidate(ctx, selected)
    assert not (ctx.promo / "stack-snapshot.json").exists()
