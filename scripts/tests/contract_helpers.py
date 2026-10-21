"""Shared scaffolding for per-package stock-contract scenario tests.

References:
    https://docs.pytest.org/en/stable/how-to/monkeypatch.html
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import faux_provider as fp
import package_contracts as pc


class StubProvider:
    """Minimal provider context exposing one recorded request."""

    def __init__(self, tools: list[str]) -> None:
        """Record a model request exposing `tools`.

        Parameters:
            tools (list[str]): Tool names the fake model received.
        """
        self.requests = [fp.RecordedRequest("m", ("user",), tuple(tools), "", route=None)]

    def __enter__(self) -> StubProvider:
        """Enter the inert provider context.

        Returns:
            StubProvider: This provider.
        """
        return self

    def __exit__(self, *_args: object) -> None:
        """Leave the inert provider context.

        Parameters:
            *_args (object): Context-manager exception arguments.
        """
        return


class NoRequestProvider(StubProvider):
    """Provider context that never received a model request."""

    def __init__(self) -> None:
        """Record no requests."""
        self.requests = []


def make_context(tmp_path: Path, contract: pc.PackageContract, version: str) -> pc.Context:
    """Create the smallest scenario context for `contract`.

    Parameters:
        tmp_path (Path): Test scratch root.
        contract (pc.PackageContract): Package under test.
        version (str): Packed artifact version.

    Returns:
        pc.Context: Context with a disposable sandbox and package artifact.
    """
    work = tmp_path / "work"
    work.mkdir()
    return pc.Context(
        Path("pi"),
        pc.Sandbox(tmp_path / "sandbox", pc.locate_tools()),
        tmp_path / "installed",
        pc.PackedArtifact(contract, tmp_path / "package.tgz", version, "sha512-x", "0" * 40, 1, ()),
        work,
        (),
    )
