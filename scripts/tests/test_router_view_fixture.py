"""Keep the router writer and /stats reader contract fixture identical in both packages."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NAME = "tests/fixtures/router-view.json"


def test_router_view_fixture_is_identical_in_both_packages() -> None:
    writer = (ROOT / "packages/subscription-router" / NAME).read_bytes()
    reader = (ROOT / "packages/session-kit" / NAME).read_bytes()
    assert writer == reader
