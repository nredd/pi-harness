"""Explicit stack installation, per-test sandboxes and failure artifacts."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from harness.interactive import FIRST_FRAME_PATTERN, SOCKET_ROOT, launch_tui
from harness.isolation import check_tier
from harness.paths import ARTIFACTS_DIR, pi_command
from harness.power import keep_awake
from harness.sandbox import Sandbox, build_sandbox, install_stack
from harness.stack import find_package
from harness.tmux import reap_stale_servers

if TYPE_CHECKING:
    from collections.abc import Callable, Generator, Iterator

    from harness.tmux import TmuxPane

LOGGER = logging.getLogger(__name__)

UNSAFE_NAME = re.compile(r"[^A-Za-z0-9_.-]+")


# Older than any single run, so a concurrent run's live panes are never reaped.
STALE_TMUX_AGE_S = 6 * 3600


@pytest.fixture(scope="session")
def awake_host() -> Iterator[None]:
    """Keep detached TUI children and timing probes out of macOS maintenance sleep."""
    with keep_awake():
        yield


@pytest.fixture(scope="session")
def reap_stale_tmux() -> None:
    """Kill tmux servers that aborted earlier runs left behind."""
    reap_stale_servers(SOCKET_ROOT, STALE_TMUX_AGE_S)


def pytest_addoption(parser: pytest.Parser) -> None:
    """Require a deliberate package set for scenarios, not unit tests.

    Parameters:
        parser (pytest.Parser): pytest option registry.
    """
    parser.addoption("--stack", help="Explicit package-set JSON; required by scenarios")


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Refuse parallel shared-cost/live or nonquiet benches before any fixtures run.

    Parameters:
        config (pytest.Config): parsed runner settings.
        items (list[pytest.Item]): selected tests after marker deselection.
    """
    for tier in ("bench", "live"):
        if any(item.get_closest_marker(tier) for item in items):
            try:
                check_tier(tier, getattr(config.option, "numprocesses", None))
                if tier == "bench":
                    for item in items:
                        item.add_marker(pytest.mark.usefixtures("awake_host"))
            except ValueError as error:
                raise pytest.UsageError(str(error)) from error


@pytest.fixture(scope="session")
def template_home(tmp_path_factory: pytest.TempPathFactory, request: pytest.FixtureRequest) -> Path:
    """Install the supplied set once per worker with real Pi package discovery.

    Parameters:
        tmp_path_factory (pytest.TempPathFactory): private worker scratch.
        request (pytest.FixtureRequest): explicit `--stack` input.

    Returns:
        Path: installed throwaway HOME.
    """
    supplied = request.config.getoption("--stack")
    if not supplied:
        pytest.fail("Scenarios require `--stack <file>` and explicit `PI_BIN`")
    pi_command()
    box = install_stack(tmp_path_factory.mktemp("stack") / "install", Path(supplied).resolve())
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(box.agent_dir / "stack-evidence.json", ARTIFACTS_DIR / f"stack-{os.getpid()}.json")
    return box.home


@pytest.fixture(scope="session")
def portable_stats_artifact(template_home: Path) -> Path:
    """Resolve the exporter only from the declared installed kit.

    Parameters:
        template_home (Path): explicit installed fixture HOME.

    Returns:
        Path: package's standalone exporter.
    """
    agent = template_home / ".pi/agent"
    packages = json.loads((agent / "settings.json").read_text())["packages"]
    return find_package("pi-session-kit", packages, agent) / "dist/pi-stats-export.mjs"


@pytest.fixture(scope="session")
def rendered_settings(template_home: Path) -> dict[str, Any]:
    """Return the explicitly installed fixture's `settings.json`.

    Parameters:
        template_home (Path): installed throwaway HOME.

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
    box = build_sandbox(tmp_path / "sandbox", template_home)
    yield box
    if test_failed(request):
        save_sandbox_artifacts(box, request.node.nodeid)


@pytest.fixture
def tui(
    sandbox: Sandbox, request: pytest.FixtureRequest, reap_stale_tmux: None
) -> Iterator[Callable[..., TmuxPane]]:
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
    leftovers = [
        path
        for pattern in ("script-*.json", "*.stderr", "*.jsonl", "*.txt", "*.ansi")
        for path in box.root.glob(pattern)
    ]
    for leftover in leftovers:
        shutil.copy2(leftover, destination / leftover.name)
    for nested in box.root.glob("*/rpc-*"):
        if nested.suffix in {".jsonl", ".stderr"}:
            shutil.copy2(nested, destination / f"{nested.parent.name}-{nested.name}")
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
