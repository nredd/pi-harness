"""Keep private and identifying network and host details out of the public tree.

Inverted guard: every RFC1918, CGNAT (100.64/10) and link-local IPv4 address (zero-padded octets and
IPv4-mapped IPv6 forms included), tailnet-style hostname, ULA/link-local IPv6 address and `/Users/<user>` or
`/home/<user>` path in tracked text is rejected unless it is an allowed neutral value. Fixture files that
intentionally carry synthetic values list those exact values in `FIXTURE_VALUES`; no file is exempt wholesale.
The test never names a real network or user and builds its own inputs from parts, so it cannot leak one.
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
MAPPED_V6 = re.compile(
    r"(?<![0-9a-f:])(?:(?:0{1,4}:){5}|::)ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}(?![0-9a-f:])", re.IGNORECASE
)
TAILNET_HOST = re.compile(r"\b[\w-]+(?:\.[\w-]+)*\.(?:ts\.net|tailscale\.net)\b", re.IGNORECASE)
# Paths that start at a home root (not `/isolated/home/x`); the captured name is a placeholder or a login.
HOME_PATH = re.compile(r"(?<![\w.~-])/(?:Users|home)/(<[^>/\s]*>|\$\{?\w+\}?|[A-Za-z0-9_][\w.-]*)")
PATH_PLACEHOLDERS = frozenset({"<user>", "$USER", "${USER}", "runner"})


def ip(*octets: int) -> str:
    """Build a dotted address from parts so no private literal appears in this file."""
    return ".".join(str(o) for o in octets)


# RFC1918, CGNAT (also used by tailnets) and IPv4 link-local.
SENSITIVE = tuple(
    ipaddress.ip_network(net)
    for net in (
        "10.0" + ".0.0/8",
        "172.16" + ".0.0/12",
        "192.168" + ".0.0/16",
        "100.64" + ".0.0/10",
        "169.254" + ".0.0/16",
    )
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

# Exact synthetic values (normalized IPv4 text, or a home path name) that a fixture file may carry. Every
# entry must still appear in its file, so a stale entry fails instead of lingering as a blind spot.
FIXTURE_VALUES: dict[str, frozenset[str]] = {
    "docs/source-provenance.md": frozenset({"user"}),
    "integration/tests/test_startup.py": frozenset({"x"}),
    "packages/computer-use/test/macos-helper-client.test.mjs": frozenset({"u"}),
    "packages/dev-tools/test/fixtures/cargo/check.jsonl": frozenset({"user"}),
    "packages/dev-tools/test/fixtures/cargo/clippy-good.jsonl": frozenset({"user"}),
    "packages/plan-mode/test/child-policy.test.ts": frozenset({"u"}),
    "packages/subagents/src/output-file.ts": frozenset({"user"}),
    "packages/subagents/test/manager-registry-guard.test.ts": frozenset({"victim"}),
    "packages/subagents/test/output-file-path.test.ts": frozenset({"user"}),
    "packages/subagents/test/output-file.test.ts": frozenset({"foo", "user"}),
    # Synthetic private addresses the WSL2 smoke harness feeds through the script under test.
    "scripts/tests/test_wsl2_workflow.py": frozenset(
        {ip(172, 20, 0, 1), ip(172, 20, 0, 2), ip(172, 20, 0, 9)}
    ),
}
# Machine-generated dependency locks are not authored text.
LOCKFILE = re.compile(r"(?:^|/)(?:package-lock\.json|[^/]*\.lock)$")
# Generated build output (hash-named, rebuilt, and not authored text): `dist/` trees and source maps.
GENERATED = re.compile(r"(?:^|/)dist/|\.map$")
# Vendored forks are scanned by their own repositories.
EXCLUDED_PREFIXES = ("forks/",)


def findings(text: str) -> list[tuple[str, str]]:
    """Return `(kind, value)` for each sensitive address, hostname or home path in text, allowlist ignored."""
    found: list[tuple[str, str]] = []
    for match in IPV4.finditer(text):
        normalized = ".".join(str(int(octet)) for octet in match.group().split("."))
        try:
            address = ipaddress.ip_address(normalized)
        except ValueError:
            continue
        if address not in ALLOWED and any(address in net for net in SENSITIVE):
            found.append(("ipv4", normalized))
    for match in MAPPED_V6.finditer(text):
        mapped = ipaddress.IPv6Address(match.group()).ipv4_mapped
        if mapped is not None and mapped not in ALLOWED and any(mapped in net for net in SENSITIVE):
            found.append(("ipv4", str(mapped)))
    found += [("ipv6", m.group()) for m in IPV6.finditer(text)]
    found += [("tailnet-host", m.group()) for m in TAILNET_HOST.finditer(text)]
    found += [
        ("home-path", m.group(1)) for m in HOME_PATH.finditer(text) if m.group(1) not in PATH_PLACEHOLDERS
    ]
    return found


def violations(text: str, allowed: frozenset[str] = frozenset()) -> list[str]:
    """Return one kind label per disallowed finding, skipping exact `allowed` fixture values.

    Labels never carry the matched value so failures cannot echo a real network or user detail.
    """
    return [kind for kind, value in findings(text) if value not in allowed]


def read(name: str) -> str:
    """Read a tracked file as lenient UTF-8."""
    return (ROOT / name).read_bytes().decode("utf-8", errors="ignore")


def scanned_paths() -> list[str]:
    """Return tracked regular files in scope, excluding forks, lockfiles and generated build output."""
    out = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
    return [
        name
        for name in out
        if name
        and not name.startswith(EXCLUDED_PREFIXES)
        and not LOCKFILE.search(name)
        and not GENERATED.search(name)
        and (ROOT / name).is_file()
    ]


V6_ULA = "fd" + "00::1"
V6_LL = "fe" + "80::1"
V6_MAPPED_HEX = "::ff" + "ff:" + "0a00:0002"
V6_MAPPED_OK = "::ff" + "ff:" + "0a00:0001"
HOME = "/Users" + "/"
LINUX_HOME = "/home" + "/"


@pytest.mark.parametrize(
    ("text", "bad"),
    [
        (f"{ip(10, 0, 0, 1)} {ip(172, 16, 0, 1)} {ip(192, 168, 0, 1)} {ip(192, 168, 255, 254)}", False),
        (
            f"{ip(100, 64, 0, 1)} {ip(100, 100, 100, 100)} {ip(169, 254, 169, 254)} {ip(192, 168, 1, 1)}",
            False,
        ),
        (ip(10, 0, 0, 2), True),
        (f"host is {ip(192, 168, 7, 9)}.", True),
        (ip(192, 168, 7, 9) + ".5", False),
        (ip(10, 255, 255, 255), True),
        (ip(172, 16, 0, 2), True),
        (ip(172, 31, 255, 254), True),
        (ip(172, 32, 0, 1), False),
        (ip(192, 168, 7, 9), True),
        (ip(100, 64, 0, 2), True),
        (ip(100, 127, 255, 254), True),
        (ip(100, 128, 0, 1), False),
        (ip(169, 254, 1, 1), True),
        (ip(8, 8, 8, 8), False),
        (ip(192, 0, 2, 19), False),
        ("1." + ip(10, 0, 0, 2), False),
        (ip(999, 999, 999, 999), False),
        ("010.000." + "000.002", True),
        ("192.168." + "001.009", True),
        ("010.000." + "000.001", False),
        ("::ff" + "ff:" + ip(10, 0, 0, 2), True),
        (V6_MAPPED_HEX, True),
        (V6_MAPPED_OK, False),
        ("0:0:0:0:0:ff" + "ff:0a00:0002", True),
        ("::ff" + "ff:" + ip(8, 8, 8, 8), False),
        ("::ff" + "ff:0808:0808", False),
        (V6_ULA, True),
        (V6_LL, True),
        ("fc" + "00:abcd::2", True),
        ("2001:db8::1", False),
        ("feed: yes", False),
        ("feed::1", False),
        ("fe00::1", False),
        ("fade:", False),
        ("node.example." + "ts.net", True),
        ("node." + "tailscale.net", True),
        ("example.net", False),
        ("ts.network", False),
        (HOME + "alice/code", True),
        (LINUX_HOME + "alice", True),
        ("ls " + HOME + "alice >/dev/null", True),
        ('"' + LINUX_HOME + "alice/.cargo", True),
        (HOME + "<user>/code", False),
        (HOME + "$USER/code", False),
        (HOME + "${USER}/code", False),
        (LINUX_HOME + "runner/work", False),
        ("/isolated/home/alice", False),
        ("C:/Users" + "/alice", True),
        ("~/home/alice", False),
        (HOME + "/", False),
    ],
)
def test_violation_boundaries(text: str, bad: bool) -> None:
    """Pin ranges, allowlist, zero-padded and mapped forms, and the hostname, IPv6 and home-path patterns."""
    assert bool(violations(text)) is bad


def test_fixture_allowlist_matches_exact_values_only() -> None:
    """A per-file allowlist silences only the listed values, never a different one."""
    listed, other = ip(172, 20, 0, 2), ip(172, 20, 0, 3)
    assert violations(f"{listed} {other}", frozenset({listed})) == ["ipv4"]
    assert not violations(f"{HOME}fixture", frozenset({"fixture"}))
    assert violations(f"{HOME}fixture", frozenset({"other"})) == ["home-path"]


def test_findings_report_kind_not_value() -> None:
    """`violations` labels never contain the matched value."""
    labels = violations(f"{ip(10, 9, 9, 9)} {HOME}alice")
    assert labels == ["ipv4", "home-path"]


def test_scope_covers_whole_tree_but_not_forks_locks_or_generated() -> None:
    """The scan reaches every authored tracked file, fixtures and this file included."""
    paths = scanned_paths()
    for expected in (
        "README.md",
        ".github/workflows/runner-smoke.yml",
        "scripts/wsl2_smoke.sh",
        "scripts/tests/test_private_probe_addresses.py",
        "scripts/tests/test_wsl2_workflow.py",
    ):
        assert expected in paths
    assert any(p.startswith("packages/") for p in paths)
    assert any(p.startswith("integration/") for p in paths)
    assert not any(p.startswith("forks/") or LOCKFILE.search(p) or GENERATED.search(p) for p in paths)


def test_tracked_tree_has_no_private_details() -> None:
    """Scan the whole tracked tree. Failures report paths and kinds only, never matched values."""
    flagged = {
        name: sorted(set(violations(read(name), FIXTURE_VALUES.get(name, frozenset()))))
        for name in scanned_paths()
    }
    assert not {name: kinds for name, kinds in flagged.items() if kinds}


def test_fixture_allowlist_has_no_stale_entries() -> None:
    """Each allowlisted fixture value must still be present in its file."""
    stale = [
        name
        for name, values in FIXTURE_VALUES.items()
        if not values <= {value for _, value in findings(read(name))}
    ]
    assert not stale, stale
