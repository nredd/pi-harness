"""Typed pi-dev-tools vs the raw Bash command they replace, deterministically.

Each pair runs the Bash form and the typed form in one headless pi on the same fixture repo and
records what the model would have paid for: result bytes and wall time per call. The faux script
is fixed, so this says nothing about how a model *chooses* tools; it says whether the typed tool
is at least as cheap and at least as informative as the Bash call it stands in for.

Correctness comes first: a smaller result that lost facts does not count. Then the byte ratio
has a ceiling (typed must not be fatter than Bash) and the typed wall time goes in the baseline.
"""

from __future__ import annotations

import subprocess
from typing import TYPE_CHECKING, Any

import pytest

from harness.bench import check_against_baseline, check_ceiling, measure_many
from harness.headless import ToolOutcome, run_headless
from harness.paths import GIT_BIN

if TYPE_CHECKING:
    from pathlib import Path

    from harness.sandbox import Sandbox

pytestmark = pytest.mark.bench

COMMITS = 60
GIT_IDENTITY = ["-c", "user.name=h", "-c", "user.email=h@h", "-c", "commit.gpgsign=false"]


def make_repo(root: Path) -> Path:
    """A repo with `COMMITS` commits, five modified files, three untracked, one staged, a long diff.

    Parameters:
        root (Path): directory to create under.

    Returns:
        Path: repository path.
    """
    repo = root / "bench-repo"
    repo.mkdir()
    git = [GIT_BIN, *GIT_IDENTITY, "-C", str(repo)]
    subprocess.check_call([GIT_BIN, "init", "-q", "-b", "main", str(repo)])
    for index in range(COMMITS):
        (repo / f"file{index % 10}.txt").write_text("\n".join(f"line {index} {n}" for n in range(40)) + "\n")
        subprocess.check_call([*git, "add", "-A"])
        subprocess.check_call([*git, "commit", "-q", "-m", f"Commit {index}"])
    for index in range(5):
        path = repo / f"file{index}.txt"
        path.write_text(path.read_text().replace("line", "LINE") + "tail\n" * 80)
    for index in range(3):
        (repo / f"new{index}.txt").write_text("new\n")
    (repo / "staged.txt").write_text("s\n")
    subprocess.check_call([*git, "add", "staged.txt"])
    return repo


PAIRS: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {
    "status": ({"name": "bash", "args": {"command": "git status"}}, {"name": "git_status", "args": {}}),
    "log": (
        {"name": "bash", "args": {"command": "git log -n 20"}},
        {"name": "git_log", "args": {"max_count": 20}},
    ),
    "diff": ({"name": "bash", "args": {"command": "git diff"}}, {"name": "git_diff", "args": {}}),
}
# Typed output may be at most this fraction of the Bash output. `diff` is exempt: the typed form
# deliberately adds the stat on top of the patch, so it is measured on time and facts only.
BYTES_CEILING = {"status": 1.0, "log": 1.0}


def run_pair(sandbox: Sandbox, repo: Path, pair: str) -> tuple[ToolOutcome, ToolOutcome]:
    """Run the Bash and typed forms of `pair` as two sequential steps in one pi.

    Parameters:
        sandbox (Sandbox): pi home.
        repo (Path): fixture repo.
        pair (str): key in `PAIRS`.

    Returns:
        tuple[ToolOutcome, ToolOutcome]: (bash, typed).
    """
    bash_call, typed_call = PAIRS[pair]
    result = run_headless(
        sandbox,
        {
            "providers": {
                "faux": {
                    "models": ["main"],
                    "steps": [{"tools": [bash_call]}, {"tools": [typed_call]}, {"text": "OK"}],
                }
            }
        },
        ["go"],
        cwd=repo,
        persist_session=False,
    )
    assert result.returncode == 0, result.transcript()
    outcomes = {o.name: o for o in result.tool_outcomes()}
    bash, typed = outcomes["bash"], outcomes[typed_call["name"]]
    assert not bash.is_error, result.transcript()
    assert not typed.is_error, result.transcript()
    return bash, typed


def assert_same_facts(pair: str, bash: ToolOutcome, typed: ToolOutcome) -> None:
    """The typed result names everything the Bash result names.

    Parameters:
        pair (str): which pair.
        bash (ToolOutcome): raw command outcome.
        typed (ToolOutcome): typed tool outcome.
    """
    if pair == "status":
        for name in ("file0.txt", "file4.txt", "new0.txt", "new2.txt", "staged.txt"):
            assert name in typed.text, typed.text
        assert list(typed.structured["untracked"]) == ["new0.txt", "new1.txt", "new2.txt"]
    elif pair == "log":
        subjects = [c["subject"] for c in typed.structured["commits"]]
        assert subjects == [f"Commit {n}" for n in range(COMMITS - 1, COMMITS - 21, -1)]
        for subject in subjects:
            assert subject in bash.text
    elif pair == "diff":
        assert bash.text.count("\n+") == typed.text.count("\n+"), "typed diff dropped added lines"
        assert bash.text.count("\n-") == typed.text.count("\n-"), "typed diff dropped removed lines"


@pytest.mark.parametrize("pair", sorted(PAIRS))
def test_typed_vs_bash(sandbox: Sandbox, pair: str) -> None:
    """Typed tool is as informative, no fatter (where comparable), and its wall time holds."""
    repo = make_repo(sandbox.workdir)
    first_bash, first_typed = run_pair(sandbox, repo, pair)
    assert_same_facts(pair, first_bash, first_typed)

    def sample() -> dict[str, float]:
        bash, typed = run_pair(sandbox, repo, pair)
        return {
            "bash_bytes": float(len(bash.text.encode())),
            "typed_bytes": float(len(typed.text.encode())),
            "typed_wall_s": typed.duration_s,
            "bash_wall_s": bash.duration_s,
        }

    medians = measure_many(sample, samples=3)
    ratio = medians["typed_bytes"] / max(1.0, medians["bash_bytes"])
    if pair in BYTES_CEILING:
        check_ceiling(f"git_{pair}_bytes_ratio", ratio, BYTES_CEILING[pair])
    # Spawn overhead guard: the typed tool may not be slower than twice the Bash call plus 50ms.
    check_ceiling(f"git_{pair}_typed_wall_s", medians["typed_wall_s"], medians["bash_wall_s"] * 2 + 0.05)
    check_against_baseline(f"git_{pair}_typed_wall_s", medians["typed_wall_s"])
