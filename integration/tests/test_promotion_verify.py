"""`promotion_verify` evidence reads and candidate construction with injected command runners.

`run_command` is the module's only process boundary, so each test replaces it with a recording
replay: no `gh`, `git` or network call leaves the process.
"""

from __future__ import annotations

import os
import runpy
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from harness import promotion, promotion_verify, runtime_lock
from harness.promotion import CoreEvidence, EvidenceError, OwnedPackageEvidence, StackSnapshot
from harness.runtime_lock import DependencyGraph, NpmGraph, RuntimeLocks
from harness.stack import Stack, source_string

if TYPE_CHECKING:
    from collections.abc import Callable

ROOT = Path(__file__).parents[2]
PERSONAL = ROOT / "integration/stacks/personal.json"
SHA = "a" * 40


def replay(
    outputs: dict[str, str], calls: list[tuple[str, ...]]
) -> Callable[..., subprocess.CompletedProcess[str]]:
    """Build a `run_command` replacement answering from canned stdout.

    Parameters:
        outputs (dict[str, str]): last-argument suffix to stdout; the first matching suffix wins.
        calls (list[tuple[str, ...]]): receives every argv.

    Returns:
        Callable[..., subprocess.CompletedProcess[str]]: the recording runner.
    """

    def run(*args: str, **_kwargs: Any) -> subprocess.CompletedProcess[str]:
        """Record one command and return its canned output.

        Parameters:
            *args (str): argv.
            **_kwargs (Any): ignored `run_command` options.

        Returns:
            subprocess.CompletedProcess[str]: the canned result.

        Raises:
            AssertionError: the argv matches no canned output.
        """
        calls.append(args)
        for suffix, stdout in outputs.items():
            if args[-1].endswith(suffix):
                return subprocess.CompletedProcess(list(args), 0, stdout, "")
        raise AssertionError(f"unexpected command {args}")

    return run


def test_gh_json_decodes_slurped_pages_from_the_runner(monkeypatch: pytest.MonkeyPatch) -> None:
    """`gh_json` asks for every page in one slurped document and returns it decoded."""
    calls: list[tuple[str, ...]] = []
    monkeypatch.setattr(promotion_verify, "run_command", replay({"main": '[[{"type": "x"}]]'}, calls))
    assert promotion_verify.gh_json("repos/o/r/rules/branches/main") == [[{"type": "x"}]]
    assert calls == [("gh", "api", "--paginate", "--slurp", "repos/o/r/rules/branches/main")]


def test_gh_json_refuses_a_non_json_response(monkeypatch: pytest.MonkeyPatch) -> None:
    """Non-JSON output is an `EvidenceError` naming the path, not a raw decode error."""
    monkeypatch.setattr(promotion_verify, "run_command", replay({"main": "<html>rate limited"}, []))
    with pytest.raises(
        EvidenceError, match=r"Unreadable response from gh api repos/o/r/rules/branches/main: "
    ):
        promotion_verify.gh_json("repos/o/r/rules/branches/main")


def owned_evidence(stack: Stack, entries: dict[str, Any]) -> list[OwnedPackageEvidence]:
    """Derive owned package evidence that agrees with a runtime lock.

    Parameters:
        stack (Stack): the stack whose `@nredd/` sources are owned.
        entries (dict[str, Any]): the lock's `packages` map.

    Returns:
        list[OwnedPackageEvidence]: one record per owned source.
    """
    owned = []
    for package in stack.sources:
        source = source_string(package)
        if source.startswith("npm:@nredd/"):
            tag = source.removeprefix("npm:")
            name = tag.rsplit("@", 1)[0]
            owned.append(
                OwnedPackageEvidence(package=tag, integrity=entries[f"node_modules/{name}"]["integrity"])
            )
    return owned


def candidate_context(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, owned: Callable[[Stack, dict[str, Any]], list[Any]]
) -> tuple[promotion_verify.VerifyContext, list[tuple[NpmGraph, Path, dict[str, str]]]]:
    """Wire `build_candidate` to the source-selected stack and lock with every external read replayed.

    Parameters:
        tmp_path (Path): fixture directory.
        monkeypatch (pytest.MonkeyPatch): patches the module.
        owned (Callable[[Stack, dict[str, Any]], list[Any]]): builds the owned evidence from the stack
            and the darwin agent lock entries.

    Returns:
        tuple[promotion_verify.VerifyContext, list[tuple[NpmGraph, Path, dict[str, str]]]]: the context
            and the recorded `acquire` calls.
    """
    personal = PERSONAL.read_text()
    locks = (ROOT / runtime_lock.SOURCE_LOCK).read_text()
    stack = Stack.model_validate_json(personal)
    entries = RuntimeLocks.model_validate_json(locks).platforms["darwin-arm64"]["agent"].lock["packages"]
    acquired: list[tuple[NpmGraph, Path, dict[str, str]]] = []

    def acquire(graph: NpmGraph, scratch: Path, checksums: dict[str, str] | None = None) -> dict[str, Path]:
        """Record the graph and pinned core checksums instead of reaching the registry.

        Parameters:
            graph (NpmGraph): graph to acquire.
            scratch (Path): its scratch directory.
            checksums (dict[str, str] | None): pinned core asset digests.

        Returns:
            dict[str, Path]: no archives.
        """
        acquired.append((graph, scratch, checksums or {}))
        return {}

    run = replay({":integration/stacks/personal.json": personal, f":{runtime_lock.SOURCE_LOCK}": locks}, [])
    monkeypatch.setattr(promotion_verify, "require_full_verification", lambda _repo, _sha: 777)
    monkeypatch.setattr(promotion_verify, "gh_json", lambda _path: [])
    monkeypatch.setattr(promotion_verify, "required_checks", lambda _rules: ["fixture"])
    monkeypatch.setattr(promotion_verify, "verify_required_checks", lambda *_args: ["fixture"])
    monkeypatch.setattr(promotion_verify, "run_command", run)
    monkeypatch.setattr(
        promotion_verify,
        "verify_core",
        lambda selected, _dir: CoreEvidence(tag=selected.core.tag, integrity=dict(selected.core.integrity)),
    )
    monkeypatch.setattr(promotion_verify, "collect_owned_evidence", lambda *_args: owned(stack, entries))
    monkeypatch.setattr(promotion_verify, "acquire", acquire)
    (tmp_path / "promo").mkdir()
    ctx = promotion_verify.VerifyContext(
        operation="verify-only",
        requested_sha=SHA,
        repo="o/r",
        workspace=tmp_path,
        github_output=tmp_path / "output",
        temp=tmp_path / "runner",
        promo=tmp_path / "promo",
    )
    return ctx, acquired


def test_build_candidate_writes_the_snapshot_and_graph_after_acquiring_every_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Every platform graph is acquired against the pinned core assets before both assets are written."""
    ctx, acquired = candidate_context(tmp_path, monkeypatch, owned_evidence)
    promotion_verify.build_candidate(ctx, SHA)
    stack = Stack.model_validate_json(PERSONAL.read_bytes())
    expected = {
        promotion.release_asset_url(stack.core.tag, name): digest
        for name, digest in stack.core.integrity.items()
    }
    runtime = RuntimeLocks.model_validate_json((ROOT / runtime_lock.SOURCE_LOCK).read_bytes())
    assert [scratch for _graph, scratch, _sums in acquired] == [
        tmp_path / "runner" / "runtime" / target / kind
        for target, graphs in runtime.platforms.items()
        for kind in graphs
    ]
    assert all(sums == expected for _graph, _scratch, sums in acquired)
    graph = DependencyGraph.model_validate_json((tmp_path / "promo" / runtime_lock.ASSET).read_bytes())
    assert (graph.source_sha, graph.runtime) == (SHA, runtime)
    snapshot = StackSnapshot.model_validate_json(
        (tmp_path / "promo" / promotion_verify.SNAPSHOT_FILE).read_bytes()
    )
    assert (snapshot.source_sha, snapshot.gates.stack_run_ids, snapshot.gates.required_checks) == (
        SHA,
        [777],
        ["fixture"],
    )


def test_build_candidate_refuses_a_lock_that_disagrees_with_owned_provenance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A runtime lock pinning different owned bytes than the verified registry evidence fails closed."""

    def tampered(stack: Stack, entries: dict[str, Any]) -> list[OwnedPackageEvidence]:
        """Swap the first owned package's integrity for another valid digest.

        Parameters:
            stack (Stack): selected stack.
            entries (dict[str, Any]): darwin agent lock entries.

        Returns:
            list[OwnedPackageEvidence]: evidence whose first record disagrees with the lock.
        """
        owned = owned_evidence(stack, entries)
        owned[0] = owned[0].model_copy(update={"integrity": "sha512-" + "A" * 86 + "=="})
        return owned

    ctx, acquired = candidate_context(tmp_path, monkeypatch, tampered)
    with pytest.raises(
        EvidenceError, match=r"Runtime 'darwin-arm64' lock differs from owned provenance for '@nredd/"
    ):
        promotion_verify.build_candidate(ctx, SHA)
    assert acquired == []
    assert not (tmp_path / "promo" / runtime_lock.ASSET).exists()


def test_module_entrypoint_exits_1_on_a_missing_environment(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`python -m harness.promotion_verify` turns a refusal into exit status 1 and a one-line error."""
    for name in ("OPERATION", "GITHUB_REPOSITORY", "GITHUB_WORKSPACE", "GITHUB_OUTPUT", "PROMO"):
        monkeypatch.delenv(name, raising=False)
    assert "OPERATION" not in os.environ
    monkeypatch.delitem(sys.modules, "harness.promotion_verify")
    with pytest.raises(SystemExit) as exit_info:
        runpy.run_module("harness.promotion_verify", run_name="__main__")
    assert exit_info.value.code == 1
    assert capsys.readouterr().err == (
        "FAILED: Missing environment: OPERATION, GITHUB_REPOSITORY, GITHUB_WORKSPACE, GITHUB_OUTPUT, PROMO\n"
    )
