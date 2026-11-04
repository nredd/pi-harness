"""Resolve the local coverage base from verified Git divergence in real disposable histories.

References:
    ../../docs/coverage.md
    https://github.com/nredd/pi-harness/issues/282
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_accounting import git_read
from tests.test_coverage_accounting import SCRIPT, policy, setup_report
from tests.test_coverage_round2 import commit_base

ROOT = SCRIPT.parent.parent
FIXTURE_IDENTITY = [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
]


def commit(root: Path, message: str) -> str:
    """Commit every fixture change with no ambient identity, signing or hooks.

    Parameters:
        root (Path): Disposable repository.
        message (str): Commit subject.
    Returns:
        str: Full commit SHA.
    Raises:
        subprocess.CalledProcessError: Git cannot commit the fixture.
    """
    git_read(root, ["add", "-A"])
    git_read(root, [*FIXTURE_IDENTITY, "commit", "-qm", message])
    return git_read(root, ["rev-parse", "HEAD"]).strip()


def source_history(root: Path) -> tuple[str, str]:
    """Check out a topic that diverged before `origin/main` added an owned source file.

    Parameters:
        root (Path): Disposable repository.
    Returns:
        tuple[str, str]: Divergence SHA and the newer `origin/main` SHA.
    Raises:
        OSError: Fixture files cannot be written.
        subprocess.CalledProcessError: Git history setup fails.
    """
    setup_report(root)
    cfg = policy()
    cfg.packages["example"].signals["primary"].files = None
    commit_base(root, cfg)
    git_read(root, ["branch", "-M", "main"])
    base = git_read(root, ["rev-parse", "HEAD"]).strip()
    git_read(root, ["checkout", "-qb", "topic"])
    (root / "topic.txt").write_text("source topic\n")
    commit(root, "Topic")
    git_read(root, ["checkout", "-q", "main"])
    (root / "packages/example/src/newer.ts").write_text("export const newer = 1;\n")
    target = commit(root, "Main-only addition")
    git_read(root, ["update-ref", "refs/remotes/origin/main", target])
    git_read(root, ["checkout", "-q", "topic"])
    return base, target


def gate(root: Path, *args: str) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    """Run the real accounting CLI against only the disposable tree.

    Parameters:
        root (Path): Disposable repository and LCOV root.
        args (str): Base-selection CLI arguments.
    Returns:
        tuple[subprocess.CompletedProcess[str], list[str]]: Process result and summary errors.
    Raises:
        OSError: The CLI or its summary cannot be accessed.
    """
    summary = root / ".git/summary.json"
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(root), "--summary", str(summary), *args],
        capture_output=True,
        text=True,
        check=False,
    )
    errors = json.loads(summary.read_text())["errors"] if summary.exists() else []
    return result, errors


def test_main_only_addition_is_not_a_topic_deletion(tmp_path: Path) -> None:
    """Compare a stale topic with its own divergence, not with files only newer main has.

    Parameters:
        tmp_path (Path): Disposable Git repository.
    Returns:
        None: The divergence gate passes and logs the resolved base.
    Raises:
        AssertionError: A main-only addition is attributed to the topic as a deletion.
    """
    base, _ = source_history(tmp_path)
    result, errors = gate(tmp_path, "--base", "origin/main")
    assert result.returncode == 1
    assert "Inventory ratchet requires `reclassifications`" in str(errors)
    assert "packages/example/src/newer.ts" in str(errors)
    result, errors = gate(tmp_path, "--compare-ref", "origin/main")
    assert result.returncode == 0, result.stderr
    assert errors == []
    assert f"Coverage base: '{base}'" in result.stderr


@pytest.mark.parametrize("change", ["deletion", "reclassification"])
def test_actual_topic_source_loss_still_ratchets(tmp_path: Path, change: str) -> None:
    """Keep rejecting the topic's own undeclared source loss against its divergence.

    Parameters:
        tmp_path (Path): Disposable Git repository.
        change (str): Real membership regression the topic commits.
    Returns:
        None: The inventory ratchet rejects the topic.
    Raises:
        AssertionError: Divergence resolution masks a real loss.
    """
    source_history(tmp_path)
    source = tmp_path / "packages/example/src/index.ts"
    (source.parent / "kept.ts").write_text("export const kept = 1;\n")
    if change == "deletion":
        source.unlink()
    else:
        path = tmp_path / "coverage/policy.json"
        cfg = json.loads(path.read_text())
        cfg["verification_helpers"] = [
            {"path": "packages/example/src/index.ts", "reason": "Fixture role change without a ledger entry."}
        ]
        cfg["packages"]["example"]["owned"] = ["src/kept.ts"]
        path.write_text(json.dumps(cfg))
    commit(tmp_path, change)
    result, errors = gate(tmp_path, "--compare-ref", "origin/main")
    assert result.returncode == 1
    assert "Inventory ratchet requires `reclassifications`" in str(errors)
    assert "packages/example/src/index.ts" in str(errors)
    assert "newer.ts" not in str(errors)


def test_explicit_base_is_used_unchanged_on_a_synthetic_merge(tmp_path: Path) -> None:
    """Keep hosted synthetic-merge and frozen-acceptance bases exactly as given.

    Parameters:
        tmp_path (Path): Disposable Git repository.
    Returns:
        None: The merged tree passes against its explicit target SHA and still ratchets
        a deletion of a file only that target has.
    Raises:
        AssertionError: An explicit base is rewritten or ignored.
    """
    _, target = source_history(tmp_path)
    git_read(tmp_path, [*FIXTURE_IDENTITY, "merge", "--no-ff", "-qm", "Synthetic merge", target])
    report = tmp_path / "packages/example/coverage/lcov.info"
    report.write_text(report.read_text() + report.read_text().replace("src/index.ts", "src/newer.ts"))
    result, errors = gate(tmp_path, "--base", target)
    assert result.returncode == 0, result.stderr
    assert errors == []
    assert "Coverage base:" not in result.stderr
    (tmp_path / "packages/example/src/newer.ts").unlink()
    result, errors = gate(tmp_path, "--base", target)
    assert result.returncode == 1
    assert "packages/example/src/newer.ts" in str(errors)


@pytest.mark.parametrize(
    ("reference", "message"),
    [
        ("origin/missing", "Not a valid object name"),
        ("", "Not a valid object name"),
        ("unrelated", "no common ancestor"),
    ],
)
def test_unresolvable_comparison_ref_fails_closed(tmp_path: Path, reference: str, message: str) -> None:
    """Reject a missing, empty or unrelated comparison ref instead of falling back.

    Parameters:
        tmp_path (Path): Disposable Git repository.
        reference (str): Comparison ref with no usable divergence.
        message (str): Diagnostic expected in the summary.
    Returns:
        None: The gate fails before any accounting.
    Raises:
        AssertionError: An unresolvable ref becomes an accepted base.
    """
    source_history(tmp_path)
    git_read(tmp_path, ["checkout", "-q", "--orphan", "unrelated"])
    commit(tmp_path, "Unrelated root")
    git_read(tmp_path, ["checkout", "-q", "topic"])
    result, errors = gate(tmp_path, "--compare-ref", reference)
    assert result.returncode == 1
    assert len(errors) == 1
    assert f"Cannot resolve the coverage base from '{reference}'" in errors[0]
    assert message in errors[0]


def test_multiple_merge_bases_fail_closed(tmp_path: Path) -> None:
    """Reject criss-cross history rather than picking one of several divergences.

    Parameters:
        tmp_path (Path): Disposable repository with real criss-cross merges.
    Returns:
        None: Ambiguous divergence fails before accounting.
    Raises:
        AssertionError: Several merge bases are silently reduced to one.
    """
    base, target = source_history(tmp_path)
    topic = git_read(tmp_path, ["rev-parse", "HEAD"]).strip()
    tree = git_read(tmp_path, ["rev-parse", f"{base}^{{tree}}"]).strip()
    left = git_read(tmp_path, [*FIXTURE_IDENTITY, "commit-tree", tree, "-p", topic, "-p", target, "-m", "L"])
    right = git_read(tmp_path, [*FIXTURE_IDENTITY, "commit-tree", tree, "-p", target, "-p", topic, "-m", "R"])
    git_read(tmp_path, ["update-ref", "refs/heads/topic", left.strip()])
    git_read(tmp_path, ["update-ref", "refs/remotes/origin/main", right.strip()])
    assert len(git_read(tmp_path, ["merge-base", "--all", "HEAD", "origin/main"]).split()) == 2
    result, errors = gate(tmp_path, "--compare-ref", "origin/main")
    assert result.returncode == 1
    assert errors == [
        f"Expected one merge base of HEAD and 'origin/main', found 2: '{sorted([topic, target])}'"
    ]


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (["--base", ""], "--base or --compare-ref is required"),
        (["--base", "HEAD", "--compare-ref", "origin/main"], "not allowed with argument"),
        (["--measure", "--compare-ref", "origin/main"], "--measure cannot enforce"),
    ],
)
def test_base_selection_arguments_are_exclusive(tmp_path: Path, args: list[str], message: str) -> None:
    """Reject an empty explicit base and any mix of base modes before reading reports.

    Parameters:
        tmp_path (Path): Disposable Git repository.
        args (list[str]): Invalid base-selection arguments.
        message (str): Expected argparse diagnostic.
    Returns:
        None: Argparse exits 2 with no summary written.
    Raises:
        AssertionError: An invalid selection falls back to another base.
    """
    source_history(tmp_path)
    result, errors = gate(tmp_path, *args)
    assert result.returncode == 2
    assert message in result.stderr
    assert errors == []


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ([], "--compare-ref origin/main"),
        (["BASE=0123abcd"], '--base "0123abcd"'),
        (["BASE="], '--base ""'),
    ],
)
def test_make_defaults_to_divergence_and_passes_explicit_base(
    tmp_path: Path, overrides: list[str], expected: str
) -> None:
    """Select divergence only when `BASE` is unset; pass any explicit `BASE`, even empty, through.

    Parameters:
        tmp_path (Path): Empty make working directory.
        overrides (list[str]): Make command-line variables.
        expected (str): Base selection the recipe must print.
    Returns:
        None: `make -n` prints the expected accounting arguments.
    Raises:
        AssertionError: The recipe falls back to a moving `origin/main` tree.
    """
    result = subprocess.run(
        ["make", "-f", str(ROOT / "Makefile"), "-n", "check-coverage", *overrides],
        cwd=tmp_path,
        env={key: value for key, value in os.environ.items() if key not in {"MAKEFLAGS", "MFLAGS", "BASE"}},
        capture_output=True,
        text=True,
        check=True,
    )
    assert f"scripts/coverage_accounting.py {expected}" in result.stdout


def test_hosted_accounting_passes_an_explicit_base() -> None:
    """Keep every workflow `check-coverage` on its event base, never the local divergence default.

    Parameters:
        None.
    Returns:
        None: Each workflow invocation sets `BASE` explicitly.
    Raises:
        AssertionError: A workflow would silently switch to `--compare-ref origin/main`.
    """
    calls = [
        line.strip()
        for workflow in sorted((ROOT / ".github/workflows").glob("*.yml"))
        for line in workflow.read_text().splitlines()
        if "make check-coverage" in line
    ]
    assert calls
    assert all('BASE="$BASE"' in call for call in calls), calls
