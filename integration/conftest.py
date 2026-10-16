"""Shared fixtures: one chezmoi render per session, one sandbox per test, artifacts on failure."""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
from typing import TYPE_CHECKING, Any

import pytest

from harness.interactive import FIRST_FRAME_PATTERN, SOCKET_ROOT, launch_tui
from harness.paths import ARTIFACTS_DIR, CHEZMOI_BIN, HOME
from harness.power import keep_awake
from harness.sandbox import Sandbox, build_sandbox, local_overrides_from_env, render_chezmoi_pi_tree
from harness.stats import PORTABLE_ARTIFACT
from harness.tmux import reap_stale_servers

if TYPE_CHECKING:
    from collections.abc import Callable, Generator, Iterator
    from pathlib import Path

    from harness.tmux import TmuxPane

LOGGER = logging.getLogger(__name__)

UNSAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]+")


# Older than any single run, so a concurrent run's live panes are never reaped.
STALE_TMUX_AGE_S = 6 * 3600


@pytest.fixture(scope="session", autouse=True)
def awake_host() -> Iterator[None]:
    """Keep detached TUI children and timing probes out of macOS maintenance sleep."""
    with keep_awake():
        yield


@pytest.fixture(scope="session", autouse=True)
def reap_stale_tmux() -> None:
    """Kill tmux servers that aborted earlier runs left behind."""
    reap_stale_servers(SOCKET_ROOT, STALE_TMUX_AGE_S)


@pytest.fixture(scope="session")
def template_home(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Render the chezmoi `~/.pi` tree once per session.

    Parameters:
        tmp_path_factory (pytest.TempPathFactory): pytest temp dirs.

    Returns:
        Path: stand-in `$HOME` holding the rendered tree.
    """
    home = tmp_path_factory.mktemp("template-home")
    render_chezmoi_pi_tree(home)
    return home


@pytest.fixture(scope="session")
def portable_stats_artifact(template_home: Path) -> Path:
    """Render the managed standalone CLI, not an installed or rebuilt kit bundle.

    Parameters:
        template_home (Path): session's rendered chezmoi home.

    Returns:
        Path: actual managed artifact for package-free producers.
    """
    artifact = template_home / PORTABLE_ARTIFACT
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_bytes(
        subprocess.check_output([CHEZMOI_BIN, "cat", str(HOME / PORTABLE_ARTIFACT)], stderr=subprocess.STDOUT)
    )
    return artifact


@pytest.fixture(scope="session")
def rendered_settings(template_home: Path) -> dict[str, Any]:
    """Return the chezmoi-rendered `settings.json`.

    Parameters:
        template_home (Path): session render of `~/.pi`.

    Returns:
        dict[str, Any]: parsed settings.
    """
    return json.loads((template_home / ".pi" / "agent" / "settings.json").read_text())


@pytest.fixture
def sandbox(tmp_path: Path, template_home: Path, request: pytest.FixtureRequest) -> Iterator[Sandbox]:
    """Yield a fresh sandbox; copy it to `artifacts/<test>/` when the test fails.

    Parameters:
        tmp_path (Path): per-test scratch dir.
        template_home (Path): session render.
        request (pytest.FixtureRequest): used to inspect the test outcome.

    Yields:
        Sandbox: ready-to-launch sandbox.
    """
    box = build_sandbox(tmp_path / "sandbox", template_home, local_overrides_from_env())
    yield box
    if test_failed(request):
        save_sandbox_artifacts(box, request.node.nodeid)


@pytest.fixture
def tui(sandbox: Sandbox, request: pytest.FixtureRequest) -> Iterator[Callable[..., TmuxPane]]:
    """Yield a launcher for interactive pi panes; save captures on failure and kill them all.

    Parameters:
        sandbox (Sandbox): sandbox the panes run in.
        request (pytest.FixtureRequest): used to inspect the test outcome.

    Yields:
        Callable[..., TmuxPane]: `launch_tui` bound to the sandbox.
    """
    panes: list[TmuxPane] = []

    def launch(
        script: dict[str, Any],
        *,
        width: int = 120,
        height: int = 40,
        model: str = "faux/main",
        extra_args: list[str] | None = None,
        env: dict[str, str] | None = None,
        wait_pattern: str | None = FIRST_FRAME_PATTERN,
    ) -> TmuxPane:
        pane = launch_tui(
            sandbox,
            script,
            name=f"pi{len(panes)}",
            width=width,
            height=height,
            model=model,
            extra_args=extra_args,
            env=env,
            wait_pattern=wait_pattern,
        )
        panes.append(pane)
        return pane

    yield launch
    failed = test_failed(request)
    for pane in panes:
        if failed:
            destination = artifact_dir(request.node.nodeid)
            try:
                (destination / f"{pane.name}.txt").write_text(pane.capture())
                (destination / f"{pane.name}.ansi").write_text(pane.capture(styled=True))
            except RuntimeError:
                LOGGER.warning(f"Pane '{pane.name}' was gone before capture")
        pane.kill()


def test_failed(request: pytest.FixtureRequest) -> bool:
    """Report whether the test's setup or call phase failed.

    Parameters:
        request (pytest.FixtureRequest): fixture request of the test.

    Returns:
        bool: True when any recorded phase failed.
    """
    return any(
        getattr(getattr(request.node, f"rep_{phase}", None), "failed", False) for phase in ("setup", "call")
    )


def artifact_dir(nodeid: str) -> Path:
    """Return (and create) the artifact directory for a test.

    Parameters:
        nodeid (str): pytest node id.

    Returns:
        Path: `artifacts/<sanitized node id>/`.
    """
    path = ARTIFACTS_DIR / UNSAFE_NAME.sub("_", nodeid).strip("_")
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_sandbox_artifacts(box: Sandbox, nodeid: str) -> None:
    """Copy session logs and scripts out of a failed sandbox.

    Parameters:
        box (Sandbox): sandbox of the failed test.
        nodeid (str): pytest node id.
    """
    destination = artifact_dir(nodeid)
    sessions = box.agent_dir / "sessions"
    if sessions.is_dir():
        shutil.copytree(sessions, destination / "sessions", dirs_exist_ok=True)
    for leftover in [*box.root.glob("script-*.json"), *box.root.glob("*.stderr")]:
        shutil.copy2(leftover, destination / leftover.name)
    LOGGER.warning(f"Saved artifacts for '{nodeid}' to '{destination}'")


@pytest.hookimpl(wrapper=True, tryfirst=True)
def pytest_runtest_makereport(
    item: pytest.Item, call: pytest.CallInfo[None]
) -> Generator[None, pytest.TestReport, pytest.TestReport]:
    """Expose each phase's report on the item so fixtures can see failures.

    Parameters:
        item (pytest.Item): test item.
        call (pytest.CallInfo[None]): phase info.

    Yields:
        None: hook wrapper protocol.

    Returns:
        pytest.TestReport: the unchanged report.
    """
    report = yield
    setattr(item, f"rep_{report.when}", report)
    return report
