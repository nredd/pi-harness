"""Prevent identifying network addresses from entering public runner configuration."""

from __future__ import annotations

import ipaddress
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
IPV4 = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")
SHARED = ipaddress.ip_network("100.64.0." + "0/10")
LAN = ipaddress.ip_network("192.168." + "40.0/24")
ALLOWED = {ipaddress.ip_address("100.64.0.1"), ipaddress.ip_address("100.100.100.100")}


def forbidden_addresses(text: str) -> list[str]:
    """Return forbidden valid IPv4 addresses found in text."""
    found = []
    for match in IPV4.finditer(text):
        try:
            address = ipaddress.ip_address(match.group())
        except ValueError:
            continue
        if address in LAN or (address in SHARED and address not in ALLOWED):
            found.append(str(address))
    return found


@pytest.mark.parametrize(
    ("address", "forbidden"),
    [
        ("100.64.0.1", False),
        ("100.100.100.100", False),
        ("100.64.0." + "2", True),
        ("100.127.255." + "255", True),
        ("100.128.0.1", False),
        ("192.168." + "40.2", True),
        ("192.168.41.2", False),
        ("999.999.999.999", False),
    ],
)
def test_forbidden_address_boundaries(address: str, forbidden: bool) -> None:
    """Check the network boundaries and the two explicit exceptions."""
    assert bool(forbidden_addresses(address)) is forbidden


def test_public_workflows_docs_and_scripts_have_no_identifying_addresses() -> None:
    """Scan tracked workflows, documentation and scripts for forbidden IPv4 addresses."""
    paths = (
        subprocess.check_output(
            ["git", "ls-files", "-z", "--", ".github/workflows", "docs", "scripts"], cwd=ROOT
        )
        .decode()
        .split("\0")
    )
    for name in filter(None, paths):
        addresses = forbidden_addresses((ROOT / name).read_bytes().decode("utf-8", errors="ignore"))
        assert not addresses, (name, addresses)
