"""Keep disposable Git fixtures and coverage base reads inside their explicit roots.

References:
    https://git-scm.com/docs/git#Documentation/git.txt-codeGITDIRcode
    ../../docs/coverage.md
"""

from __future__ import annotations

import os
import shlex
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest
from test_coverage_round2 import scope_fixture

from coverage_accounting import git_read


def test_git_reader_clears_routing_and_injected_configuration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Remove every ambient Git override before invoking an explicit-root command.

    Parameters:
        tmp_path (Path): Disposable command root.
        monkeypatch (pytest.MonkeyPatch): Hostile environment overrides scoped to this test.
    Returns:
        None: Only the three intentional safe Git configuration variables survive.
    Raises:
        AssertionError: Routing/config keys survive or non-Git environment is lost.
    """
    for name, value in {
        "GIT_DIR": "/not-the-root",
        "GIT_WORK_TREE": "/not-the-worktree",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "core.hooksPath",
        "GIT_CONFIG_VALUE_0": "/not-the-hooks",
        "GIT_CONFIG_PARAMETERS": "'core.hooksPath=/not-the-hooks'",
        "GIT_TRACE": "/not-a-log-destination",
        "COVERAGE_FIXTURE_SENTINEL": "retained",
    }.items():
        monkeypatch.setenv(name, value)
    with patch("coverage_accounting.subprocess.check_output", wraps=subprocess.check_output) as command:
        assert git_read(tmp_path, ["--version"]).startswith("git version")
    env = command.call_args.kwargs["env"]
    assert {key: value for key, value in env.items() if key.startswith("GIT_")} == {
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_CONFIG_GLOBAL": os.devnull,
    }
    assert env["COVERAGE_FIXTURE_SENTINEL"] == "retained"


def test_hostile_git_environment_cannot_redirect_fixture_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Exercise real init/add/commit under injected routing, templates and hook configuration.

    Parameters:
        tmp_path (Path): Private parent for both owned and decoy repositories and hooks.
        monkeypatch (pytest.MonkeyPatch): Hostile Git environment scoped to this test.
    Returns:
        None: Owned HEAD is created, decoy HEAD/index stay unchanged and injected hooks never run.
    Raises:
        AssertionError: A fixture writes outside its intended repository or runs injected hooks.
    """
    decoy = tmp_path / "decoy"
    decoy.mkdir()
    scope_fixture(decoy)
    head = git_read(decoy, ["rev-parse", "HEAD"])
    index = (decoy / ".git/index").read_bytes()
    owned = tmp_path / "owned"
    owned.mkdir()
    hooks = tmp_path / "hostile-template/hooks"
    hooks.mkdir(parents=True)
    marker = tmp_path / "hook-ran"
    hook = hooks / "pre-commit"
    hook.write_text(f"#!/bin/sh\n/usr/bin/touch {shlex.quote(str(marker))}\n")
    hook.chmod(0o700)
    cfg = tmp_path / "hostile.gitconfig"
    cfg.write_text(f"[core]\n\thooksPath = {hooks.as_posix()}\n")
    injected_index = tmp_path / "injected-index"
    for name, value in {
        "GIT_DIR": str(decoy / ".git"),
        "GIT_COMMON_DIR": str(decoy / ".git"),
        "GIT_WORK_TREE": str(decoy),
        "GIT_INDEX_FILE": str(injected_index),
        "GIT_OBJECT_DIRECTORY": str(decoy / ".git/objects"),
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "core.hooksPath",
        "GIT_CONFIG_VALUE_0": str(hooks),
        "GIT_CONFIG_PARAMETERS": shlex.quote(f"core.hooksPath={hooks}"),
        "GIT_CONFIG_GLOBAL": str(cfg),
        "GIT_CONFIG_SYSTEM": str(cfg),
        "GIT_TEMPLATE_DIR": str(hooks.parent),
    }.items():
        monkeypatch.setenv(name, value)
    scope_fixture(owned)
    assert Path(git_read(owned, ["rev-parse", "--show-toplevel"]).strip()).resolve() == owned.resolve()
    assert git_read(owned, ["show", "HEAD:coverage/policy.json"])
    assert git_read(decoy, ["rev-parse", "HEAD"]) == head
    assert (decoy / ".git/index").read_bytes() == index
    assert not (owned / ".git/hooks").exists()
    assert not injected_index.exists()
    assert not marker.exists()
