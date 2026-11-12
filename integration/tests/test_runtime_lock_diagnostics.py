"""Bounded replay phase evidence over synthetic authenticated archives.

References:
- https://github.com/nredd/pi-harness/issues/783
"""

from __future__ import annotations

import itertools
import re
from pathlib import Path
from typing import Any

import pytest

from harness import runtime_lock
from harness.runtime_lock import RuntimeLockError, RuntimeLocks
from harness.stack import Stack
from tests.runtime_fixtures import fixture_graph, native_npm

ROOT = Path(__file__).parents[2]
RECORD = re.compile(
    r"Runtime replay phase=([a-z-]+) status=(ok|error) elapsed_ms=1"
    r"(?: total=([0-9]+) attempted=([0-9]+) completed=([0-9]+))?"
)
HOSTILE = "https://user:credential@example.invalid/private-package /private/path AUTH_TOKEN=secret"


def records(caplog: pytest.LogCaptureFixture) -> list[str]:
    """Require fixed-shape records with no selected input, path or exception text.

    Parameters:
        caplog (pytest.LogCaptureFixture): captured diagnostic messages.

    Returns:
        list[str]: validated fixed-shape phase messages.
    """
    messages = [record.message for record in caplog.records if record.message.startswith("Runtime replay")]
    assert messages
    assert all(RECORD.fullmatch(message) for message in messages)
    return messages


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    """Make phase durations exact and enable the existing INFO diagnostic seam.

    Parameters:
        monkeypatch (pytest.MonkeyPatch): deterministic monotonic clock seam.
        caplog (pytest.LogCaptureFixture): logger capture.

    Returns:
        None: every measured phase advances exactly one millisecond.
    """
    ticks = itertools.count(step=1_000_000)
    monkeypatch.setattr(runtime_lock.time, "monotonic_ns", lambda: next(ticks))
    caplog.set_level("INFO", logger=runtime_lock.LOGGER.name)


@pytest.mark.usefixtures("clock")
def test_synthetic_source_replay_records_actual_native_phases(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Replay both synthetic graphs through real npm and installed-byte audits.

    Parameters:
        tmp_path (Path): disposable replay prefix and private npm caches.
        monkeypatch (pytest.MonkeyPatch): synthetic transport and version command seams.
        caplog (pytest.LogCaptureFixture): sanitized phase record capture.

    Returns:
        None: actual native phases and aggregate invocation counts are observed.
    """
    graph, bodies = fixture_graph()
    stack = Stack.model_validate_json((ROOT / "integration/stacks/personal.json").read_bytes())
    runtime = RuntimeLocks.model_validate_json((ROOT / runtime_lock.SOURCE_LOCK).read_bytes())
    monkeypatch.setattr(runtime_lock, "selected_graphs", lambda runtime: {"core": graph, "agent": graph})
    monkeypatch.setattr(runtime_lock, "core_checksums", lambda stack: {})
    monkeypatch.setattr(runtime_lock, "fetch_bytes", bodies.__getitem__)
    check_output = runtime_lock.subprocess.check_output

    def smoke_or_native(*args: Any, **kwargs: Any) -> Any:
        """Run actual native npm but return hostile version output at the smoke boundary.

        Parameters:
            *args (Any): selected executable and argument list.
            **kwargs (Any): unchanged subprocess options.

        Returns:
            Any: native subprocess output or synthetic hostile version text.

        Raises:
            OSError | runtime_lock.subprocess.SubprocessError: native npm fails.
        """
        if args[0][-1] == "--version":
            return HOSTILE
        return check_output(*args, **kwargs)

    monkeypatch.setattr(runtime_lock.subprocess, "check_output", smoke_or_native)
    runtime_lock.replay_source(runtime, stack, tmp_path, native_npm())
    messages = records(caplog)
    phases = [message.split()[2].removeprefix("phase=") for message in messages]
    assert phases == [
        "selection",
        "checksums",
        "acquisition",
        "archive-verification",
        "cache-import",
        "offline-install",
        "installed-byte-audit",
        "archive-verification",
        "cache-import",
        "offline-install",
        "installed-byte-audit",
        "smoke",
    ]
    assert all("status=ok" in message for message in messages)
    assert sum("total=2 attempted=2 completed=2" in message for message in messages) == 2
    assert len(caplog.records) == 13
    assert HOSTILE not in caplog.text
    assert str(tmp_path) not in caplog.text
    assert all(name not in caplog.text for name in graph.manifest["dependencies"])


@pytest.mark.usefixtures("clock")
@pytest.mark.parametrize(
    ("failure", "phase", "counts"),
    [
        ("verification", "archive-verification", ""),
        ("cache-first", "cache-import", " total=2 attempted=1 completed=0"),
        ("cache-second", "cache-import", " total=2 attempted=2 completed=1"),
        ("install", "offline-install", ""),
        ("audit", "installed-byte-audit", ""),
    ],
)
def test_install_failure_records_partial_counts_and_propagates_unchanged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    *,
    failure: str,
    phase: str,
    counts: str,
) -> None:
    """Report only the failing phase and aggregate progress, never hostile exception details.

    Parameters:
        tmp_path (Path): disposable archive and install directories.
        monkeypatch (pytest.MonkeyPatch): bounded native failure injection.
        caplog (pytest.LogCaptureFixture): diagnostic capture.
        failure (str): operation to fail.
        phase (str): expected failed phase.
        counts (str): expected aggregate cache progress.

    Returns:
        None: failure is re-raised unchanged and no later phase runs.
    """
    graph, bodies = fixture_graph()
    monkeypatch.setattr(runtime_lock, "fetch_bytes", bodies.__getitem__)
    archives = runtime_lock.acquire(graph, tmp_path / "archives")
    error = RuntimeLockError(HOSTILE)
    attempted = 0

    def fail(*args: Any, **kwargs: Any) -> None:
        """Raise the same hostile exception object without formatting it into a log.

        Parameters:
            *args (Any): unused operation arguments.
            **kwargs (Any): unused operation options.

        Returns:
            None: never returns normally.

        Raises:
            RuntimeLockError: the unchanged synthetic operation failure.
        """
        raise error

    def run(*args: Any) -> None:
        """Fail a selected cache invocation or native offline install.

        Parameters:
            *args (Any): native executable, operation arguments and environment.

        Returns:
            None: unselected operations complete without running npm.

        Raises:
            RuntimeLockError: the selected operation fails with hostile details.
        """
        nonlocal attempted
        if args[1][0] == "cache":
            attempted += 1
            if (failure, attempted) in {("cache-first", 1), ("cache-second", 2)}:
                raise error
        elif failure == "install":
            raise error

    monkeypatch.setattr(runtime_lock, "run_npm", run)
    monkeypatch.setattr(runtime_lock, "audit_install", fail if failure == "audit" else lambda *args: None)
    if failure == "verification":
        monkeypatch.setattr(runtime_lock, "validate_archive", fail)
    with pytest.raises(RuntimeLockError) as caught:
        runtime_lock.install_graph(graph, tmp_path / "prefix", tmp_path / "npm", "/fixture/npm", archives)
    assert caught.value is error
    messages = records(caplog)
    assert messages[-1] == f"Runtime replay phase={phase} status=error elapsed_ms=1{counts}"
    assert sum("status=error" in message for message in messages) == 1
    assert len(messages) <= 4
    assert HOSTILE not in caplog.text


@pytest.mark.usefixtures("clock")
def test_cache_import_counts_unique_archives_not_graph_entries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Keep native cache invocation deduplication unchanged for repeated archive paths.

    Parameters:
        tmp_path (Path): disposable authenticated archive storage.
        monkeypatch (pytest.MonkeyPatch): native command and audit observation seams.
        caplog (pytest.LogCaptureFixture): aggregate counter capture.

    Returns:
        None: duplicate graph entries do not inflate aggregate import counts.
    """
    graph, bodies = fixture_graph()
    monkeypatch.setattr(runtime_lock, "fetch_bytes", bodies.__getitem__)
    archives = runtime_lock.acquire(graph, tmp_path / "archives")
    key, archive = next(iter(archives.items()))
    alias = "node_modules/duplicate"
    graph.lock["packages"][alias] = graph.lock["packages"][key]
    archives[alias] = archive
    calls: list[list[str]] = []
    monkeypatch.setattr(runtime_lock, "run_npm", lambda npm, args, *rest: calls.append(args))
    monkeypatch.setattr(runtime_lock, "audit_install", lambda *args: None)
    runtime_lock.install_graph(graph, tmp_path / "prefix", tmp_path / "npm", "/fixture/npm", archives)
    assert len([args for args in calls if args[0] == "cache"]) == 2
    assert any("total=2 attempted=2 completed=2" in message for message in records(caplog))


@pytest.mark.usefixtures("clock")
@pytest.mark.parametrize("phase", ["selection", "checksums", "acquisition", "smoke"])
def test_source_failure_reports_status_without_exception_details(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    phase: str,
) -> None:
    """Report failed source orchestration boundaries without leaking selected inputs.

    Parameters:
        tmp_path (Path): disposable replay root.
        monkeypatch (pytest.MonkeyPatch): explicit source operation failure seams.
        caplog (pytest.LogCaptureFixture): diagnostic capture.
        phase (str): source boundary to fail.

    Returns:
        None: failed boundaries emit one sanitized error record and stop replay.
    """
    graph, bodies = fixture_graph()
    stack = Stack.model_validate_json((ROOT / "integration/stacks/personal.json").read_bytes())
    runtime = RuntimeLocks.model_validate_json((ROOT / runtime_lock.SOURCE_LOCK).read_bytes())

    def fail(*args: Any, **kwargs: Any) -> Any:
        """Raise an operation-appropriate exception carrying private-looking data.

        Parameters:
            *args (Any): unused source operation arguments.
            **kwargs (Any): unused source operation options.

        Returns:
            Any: never returns normally.

        Raises:
            OSError: the smoke subprocess cannot start.
            RuntimeLockError: an earlier source phase fails.
        """
        if phase == "smoke":
            raise OSError(HOSTILE)
        raise RuntimeLockError(HOSTILE)

    monkeypatch.setattr(runtime_lock, "selected_graphs", lambda runtime: {"core": graph, "agent": graph})
    monkeypatch.setattr(runtime_lock, "core_checksums", lambda stack: {})
    monkeypatch.setattr(runtime_lock, "fetch_bytes", bodies.__getitem__)
    monkeypatch.setattr(runtime_lock, "install_graph", lambda *args: None)
    if phase == "selection":
        monkeypatch.setattr(RuntimeLocks, "bind", fail)
    elif phase == "checksums":
        monkeypatch.setattr(runtime_lock, "core_checksums", fail)
    elif phase == "acquisition":
        monkeypatch.setattr(runtime_lock, "acquire", fail)
    else:
        monkeypatch.setattr(runtime_lock.subprocess, "check_output", fail)
    with pytest.raises(RuntimeLockError):
        runtime_lock.replay_source(runtime, stack, tmp_path, "/fixture/npm")
    messages = records(caplog)
    assert messages[-1] == f"Runtime replay phase={phase} status=error elapsed_ms=1"
    assert sum("status=error" in message for message in messages) == 1
    assert len(messages) <= 4
    assert HOSTILE not in caplog.text
