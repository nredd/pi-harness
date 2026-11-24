"""Keep the router writer and /stats reader contract fixture identical in both packages.

References:
- https://github.com/nredd/pi-harness/issues/1407
- https://docs.python.org/3/library/pathlib.html#pathlib.Path.read_bytes
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAME = "tests/fixtures/router-view.json"


def test_router_view_fixture_is_identical_in_both_packages() -> None:
    """Assert that the writer and reader fixtures match byte for byte."""
    writer = (ROOT / "packages/subscription-router" / NAME).read_bytes()
    reader = (ROOT / "packages/session-kit" / NAME).read_bytes()
    assert writer == reader
