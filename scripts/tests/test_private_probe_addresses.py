"""Keep private and identifying network details out of the public tree.

Inverted guard: every RFC1918, CGNAT (100.64/10) and link-local IPv4 address, tailnet-style hostname
and ULA/link-local IPv6 address in tracked text is rejected unless it is an allowed neutral probe target.
The test never names a real network, so it cannot itself leak one.
"""

from __future__ import annotations

import ipaddress
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
IPV4 = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)")
IPV6 = re.compile(r"(?<![0-9a-f:])(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f])(?::[0-9a-f]{0,4}){2,}", re.IGNORECASE)
TAILNET_HOST = re.compile(r"\b[\w-]+(?:\.[\w-]+)*\.(?:ts\.net|tailscale\.net)\b", re.IGNORECASE)

# RFC1918, CGNAT (also used by tailnets) and IPv4 link-local.
SENSITIVE = tuple(
    ipaddress.ip_network(net)
    for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16")
)

# Neutral probe targets: boundary addresses of each range, the Tailscale DNS address, the cloud metadata
# address, and the generic default-router example used as the `scripts/wsl2_smoke.sh` default.
ALLOWED = frozenset(
    ipaddress.ip_address(a)
    for a in (
        "10.0.0.1",
        "172.16.0.1",
        "192.168.0.1",
        "192.168.1.1",
        "192.168.255.254",
        "100.64.0.1",
        "100.100.100.100",
        "169.254.169.254",
    )
)

# Files that intentionally contain synthetic addresses as fixtures. Each is a test that feeds made-up private
# values through the smoke tooling or this guard's own boundary cases; none holds a real network detail.
FIXTURES = frozenset({"scripts/tests/test_private_probe_addresses.py", "scripts/tests/test_wsl2_workflow.py"})
# Machine-generated dependency locks are not authored text.
LOCKFILE = re.compile(r"(?:^|/)(?:package-lock\.json|[^/]*\.lock)$")
# Vendored forks are scanned by their own repositories.
EXCLUDED_PREFIXES = ("forks/",)


def violations(text: str) -> list[str]:
    """Return one kind label per disallowed private address or tailnet hostname found in text.

    Labels never carry the matched value so failures cannot echo a real network detail.
    """
    found: list[str] = []
    for match in IPV4.finditer(text):
        try:
            address = ipaddress.ip_address(match.group())
        except ValueError:
            continue
        if address not in ALLOWED and any(address in net for net in SENSITIVE):
            found.append("ipv4")
    found += ["ipv6" for _ in IPV6.finditer(text)]
    found += ["tailnet-host" for _ in TAILNET_HOST.finditer(text)]
    return found


def scanned_paths() -> list[str]:
    """Return tracked regular files in scope, excluding forks, lockfiles and documented fixtures."""
    out = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
    return [
        name
        for name in out
        if name
        and not name.startswith(EXCLUDED_PREFIXES)
        and not LOCKFILE.search(name)
        and name not in FIXTURES
        and (ROOT / name).is_file()
    ]


@pytest.mark.parametrize(
    ("text", "bad"),
    [
        ("10.0.0.1 172.16.0.1 192.168.0.1 192.168.255.254", False),
        ("100.64.0.1 100.100.100.100 169.254.169.254 192.168.1.1", False),
        ("10.0.0.2", True),
        ("host is 192.168.7.9.", True),
        ("192.168.7.9.5", False),
        ("10.255.255.255", True),
        ("172.16.0.2", True),
        ("172.31.255.254", True),
        ("172.32.0.1", False),
        ("192.168.7.9", True),
        ("100.64.0.2", True),
        ("100.127.255.254", True),
        ("100.128.0.1", False),
        ("169.254.1.1", True),
        ("8.8.8.8", False),
        ("192.0.2.19", False),
        ("1.10.0.0.2", False),
        ("999.999.999.999", False),
        ("fd00::1", True),
        ("fe80::1", True),
        ("fc00:abcd::2", True),
        ("2001:db8::1", False),
        ("feed: yes", False),
        ("feed::1", False),
        ("fe00::1", False),
        ("fade:", False),
        ("node.example.ts.net", True),
        ("node.tailscale.net", True),
        ("example.net", False),
        ("ts.network", False),
    ],
)
def test_violation_boundaries(text: str, bad: bool) -> None:
    """Pin the range boundaries, the allowlist and the hostname and IPv6 patterns."""
    assert bool(violations(text)) is bad


def test_scope_covers_whole_tree_but_not_forks_locks_or_fixtures() -> None:
    """The scan reaches every authored tracked file and skips only the documented exclusions."""
    paths = scanned_paths()
    for expected in ("README.md", ".github/workflows/runner-smoke.yml", "scripts/wsl2_smoke.sh"):
        assert expected in paths
    assert any(p.startswith("packages/") for p in paths)
    assert any(p.startswith("integration/") for p in paths)
    assert not any(p.startswith("forks/") or LOCKFILE.search(p) or p in FIXTURES for p in paths)


def test_tracked_tree_has_no_private_network_details() -> None:
    """Scan the whole tracked tree. Findings report the path and kind only, never the matched value."""
    flagged = [
        name
        for name in scanned_paths()
        if violations((ROOT / name).read_bytes().decode("utf-8", errors="ignore"))
    ]
    assert not flagged, flagged
