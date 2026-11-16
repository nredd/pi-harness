"""Artifact reads refuse linked ancestry and special files before touching their contents.

References:
- https://github.com/nredd/pi-harness/pull/194
"""

from __future__ import annotations

import os
import runpy
import subprocess
import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

import conftest
from harness import files
from harness.credentials import main, require_safe_diagnostic
from harness.sandbox import build_sandbox
from tests.test_capture_resilience import fail_with_cleanup


@pytest.mark.parametrize("root_link", [False, True], ids=["internal-parent", "sandbox-root"])
def test_artifact_linked_ancestry_is_refused_without_reading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, root_link: bool
) -> None:
    """Even an internal link with an in-sandbox destination cannot authorize a candidate read."""
    box = build_sandbox(tmp_path / "box")
    data = box.root / "actual"
    data.mkdir()
    (data / "rpc-example.stderr").write_text("public")
    if root_link:
        link = tmp_path / "box-link"
        link.symlink_to(box.root, target_is_directory=True)
        box.root = link
    else:
        (box.root / "linked").symlink_to(data, target_is_directory=True)
    destination = tmp_path / "uploads/case"
    monkeypatch.setattr(conftest, "artifact_dir", lambda _: destination)
    read = MagicMock(side_effect=AssertionError("candidate bytes must not be opened"))
    monkeypatch.setattr(Path, "read_bytes", read)
    with pytest.raises(AssertionError, match="PRIMARY"):
        fail_with_cleanup(lambda: conftest.save_sandbox_artifacts(box, "case"))
    assert not destination.exists()
    read.assert_not_called()


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="FIFO requires POSIX")
def test_fifo_candidate_is_refused_before_any_open(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Never perform a blocking read, even in the failing-before version of this proof."""
    box = build_sandbox(tmp_path / "box")
    fifo = box.root / "pi.stderr"
    os.mkfifo(fifo)
    destination = tmp_path / "uploads/case"
    monkeypatch.setattr(conftest, "artifact_dir", lambda _: destination)
    path_read = MagicMock(side_effect=AssertionError("FIFO must never be read"))
    opened: list[Path] = []
    original_open = os.open

    def observe_open(path: Any, *args: Any, **kwargs: Any) -> int:
        """Reject only candidate opens; leave staging cleanup's directory operations real."""
        if Path(path) == fifo:
            opened.append(fifo)
            raise AssertionError("known FIFO must never be opened")
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_bytes", path_read)
    monkeypatch.setattr(files.os, "open", observe_open)
    with pytest.raises(AssertionError, match="PRIMARY"):
        fail_with_cleanup(lambda: conftest.save_sandbox_artifacts(box, "case"))
    assert not destination.exists()
    path_read.assert_not_called()
    assert not opened


@pytest.mark.parametrize(
    "payload", [b'{"access_token":"x"}', b'{"refresh_token":" "}', b"bearer x", b"Bearer !"]
)
def test_short_explicit_credential_is_refused(payload: bytes) -> None:
    """Recognizable explicit credential contexts are refused independently of secret length."""
    with pytest.raises(ValueError, match="shared credential policy"):
        require_safe_diagnostic(payload)


@pytest.mark.parametrize(
    "payload",
    [
        b'{"api_key_available":true,"access_token_count":1}',
        b'{"api_key":"","access_token":null,"auth_type":"Bearer"}',
        b'{"core_sha":"public","binary_sha256":"public","token_count":7}',
    ],
)
def test_public_metadata_does_not_match_auth_dump_fields(payload: bytes) -> None:
    """Publication is not blocked merely by public metadata keys or an empty credential slot."""
    require_safe_diagnostic(payload)


def test_scan_cli_accepts_only_wholly_safe_files(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    """Shell collectors get the shared verdict as an exit status, without credential values in logs."""
    safe = tmp_path / "guest-state.txt"
    safe.write_bytes(b"MemAvailable: 1 kB\n[ 1.0] kernel \xff line\n")
    planted = tmp_path / "planted.txt"
    secret = "ghp_" + "B" * 36
    planted.write_text(f"[ 2.0] {secret}\n")
    assert main([str(safe)]) == 0
    assert main([str(safe), str(planted)]) == 1
    assert main([str(tmp_path / "missing.txt")]) == 1
    assert secret not in caplog.text
    assert "Refused diagnostic" in caplog.text


def test_scan_cli_runs_as_module(tmp_path: Path) -> None:
    """Exercise the exact `python -m harness.credentials` entry `scripts/wsl2_capture.sh` invokes."""
    planted = tmp_path / "planted.txt"
    planted.write_text("Authorization: Bearer synthetic-value\n")
    command = [sys.executable, "-m", "harness.credentials", str(planted)]
    integration = Path(__file__).resolve().parents[1]
    result = subprocess.run(command, cwd=integration, capture_output=True, text=True, check=False)
    assert result.returncode == 1
    assert "synthetic-value" not in result.stdout + result.stderr
    planted.write_text("MemTotal: 1 kB\n")
    assert subprocess.run(command, cwd=integration, capture_output=True, check=False).returncode == 0


def test_scan_cli_main_guard_exits_with_the_verdict(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The module guard turns the scan verdict into the process exit status."""
    report = tmp_path / "guest-state.txt"
    report.write_text("SwapFree: 1 kB\n")
    monkeypatch.setattr(sys, "argv", ["harness.credentials", str(report)])
    monkeypatch.delitem(sys.modules, "harness.credentials")
    with pytest.raises(SystemExit) as raised:
        runpy.run_module("harness.credentials", run_name="__main__")
    assert raised.value.code == 0


@pytest.mark.parametrize("replacement", ["fifo", "symlink"])
def test_replaced_regular_candidate_never_blocks_or_follows_final_link(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, replacement: str
) -> None:
    """Force a stale regular precheck; descriptor flags and fstat remain authoritative."""
    candidate = tmp_path / "pi.stderr"
    if replacement == "fifo":
        os.mkfifo(candidate)
    else:
        target = tmp_path / "private"
        target.write_text("not publishable through a link")
        candidate.symlink_to(target)
    monkeypatch.setattr(files, "entry_kind", lambda _: "file")
    original_open = os.open
    flags_seen: list[int] = []

    def checked_open(path: Any, flags: int, *args: Any, **kwargs: Any) -> int:
        """Assert safe flags BEFORE opening, so a mutation can never block the test on FIFO."""
        assert flags & os.O_NONBLOCK
        assert flags & os.O_NOFOLLOW
        flags_seen.append(flags)
        return original_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(files.os, "open", checked_open)
    with pytest.raises((files.NonRegularFileError, OSError)):
        files.read_regular_bytes(candidate)
    assert flags_seen


def test_dangling_followed_link_reads_as_absent(tmp_path: Path) -> None:
    """A followed link whose target is gone is absent, like a missing file; unfollowed it is refused.

    Parameters:
        tmp_path (Path): private link and missing target.
    """
    link = tmp_path / "settings.json"
    link.symlink_to(tmp_path / "missing.json")
    assert files.read_regular(link, follow=True) is None
    with pytest.raises(files.NonRegularFileError, match="is a symlink"):
        files.read_regular(link, follow=False)


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="FIFO requires POSIX")
@pytest.mark.parametrize("follow", [False, True])
def test_entry_swapped_after_precheck_is_refused_by_fstat(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, follow: bool
) -> None:
    """A stale "regular" precheck over a FIFO is caught on the descriptor, without a blocking read.

    Parameters:
        tmp_path (Path): private FIFO.
        monkeypatch (pytest.MonkeyPatch): stale precheck and open-flag guard.
        follow (bool): accepted-link wording in the refusal.
    """
    fifo = tmp_path / "settings.json"
    os.mkfifo(fifo)
    monkeypatch.setattr(files, "entry_kind", lambda _: "file")
    original_open = os.open

    def nonblocking_open(path: Any, flags: int, *args: Any, **kwargs: Any) -> int:
        """Assert the nonblocking flag BEFORE opening, so a regression can never hang the test."""
        assert flags & os.O_NONBLOCK
        return original_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(files.os, "open", nonblocking_open)
    accepted = "a regular file or a link to one" if follow else "a regular file"
    with pytest.raises(
        files.NonRegularFileError, match=f"stopped being a regular file.*only reads {accepted} "
    ):
        files.read_regular(fifo, follow=follow)
