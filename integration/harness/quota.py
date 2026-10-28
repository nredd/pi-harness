"""Helpers for the quota-footer scenarios: fixture state, request log, footer row parsing.

The router stand-in is `providers/usage_fixture.ts`; the timer preload is `providers/fast_timers.mjs`.

References:
- Router usage RPC: `router:rpc:usage` in `nredd/pi-subscription-router` `src/index.ts`
- Snapshot shape: `UsageSnapshot` in `nredd/pi-subscription-router` `src/usage.ts`
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from harness.paths import PROVIDERS_DIR
from harness.stack import find_package, package_directory

if TYPE_CHECKING:
    from pathlib import Path

    from harness.sandbox import Sandbox

USAGE_FIXTURE_EXTENSION = PROVIDERS_DIR / "usage_fixture.ts"
FAST_TIMERS_PRELOAD = PROVIDERS_DIR / "fast_timers.mjs"
# The footer's real constants, and the scaled values the fast-timer scenarios run with.
POLL_MS = 60_000
REQUEST_TIMEOUT_MS = 12_000
FAST_POLL_MS = 1_500
FAST_TIMEOUT_MS = 800
FAST_TIMERS = {POLL_MS: FAST_POLL_MS, REQUEST_TIMEOUT_MS: FAST_TIMEOUT_MS}
# `expiresAt` offset of a fresh snapshot; long, so the footer's wall-clock expiry never fires mid-test.
FRESH_FOR_MS = 3_600_000
ROUTER_PACKAGE = "pi-subscription-router"
# Rows: `Quota left: Anthropic 5h 80% weekly 60% | OpenAI weekly ...`, compact `Left: Anth 5h 80% 7d 60% | OAI 7d ...`;
# reset suffixes (`(resets ..)` / `@..`) may follow each value, and narrow widths wrap one row per provider
# (only the first row carries the lead, so this parser sees just that row; the preset scenarios cover wrapping).
ROW_PATTERN = re.compile(r"^\s*(?P<prefix>Quota left:|Left:)\s*(?P<body>.*?)\s*$", re.MULTILINE)
PAIR_PATTERN = re.compile(r"(?P<label>[A-Za-z0-9]+)\s+(?P<value>\d+%|--)")
ANSI_PATTERN = re.compile(r"\x1b\[[0-9;]*m")
ROW_PREFIX_PATTERN = re.compile(r"^\s*(?:Quota left:|Left:)")
TOKEN_PATTERN = re.compile(r"(?P<sgr>\x1b\[[0-9;]*m)|(?P<pct>\d+)%")
PROVIDERS = {"Anthropic": "anthropic", "Anth": "anthropic", "OpenAI": "openai-codex", "OAI": "openai-codex"}
# Provider-native window names the router reports, keyed by provider.
WINDOWS = {"anthropic": ("five_hour", "seven_day"), "openai-codex": ("5h", "7d")}


def snapshot(
    provider: str,
    used: tuple[float, float] | None,
    *,
    status: str = "available",
    now_ms: int | None = None,
) -> dict[str, Any]:
    """Build a router `UsageSnapshot`.

    Parameters:
        provider (str): `anthropic` or `openai-codex`.
        used (tuple[float, float] | None): `usedPercent` of the 5h and weekly windows; `None` for none.
        status (str): `available`, `stale`, `unavailable` or `error`.
        now_ms (int | None): `retrievedAt`; defaults to the wall clock. `expiresAt` is an hour later, so the
            footer's own expiry check (wall clock) never marks a fresh snapshot stale mid-test.

    Returns:
        dict[str, Any]: JSON-ready snapshot.

    Raises:
        ValueError: `provider` is not one the router collects.
    """
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    if provider not in WINDOWS:
        raise ValueError(f"Unknown provider: '{provider}'")
    windows = [
        {"name": name, "usedPercent": value, "scope": "provider", "resetAt": now_ms + 3_600_000}
        for name, value in zip(WINDOWS[provider], used or (), strict=False)
    ]
    return {
        "provider": provider,
        "status": status,
        "windows": windows,
        "retrievedAt": now_ms,
        "expiresAt": now_ms + FRESH_FOR_MS,
    }


@dataclass(frozen=True)
class UsageFixture:
    """The fixture's state file and request log inside one sandbox.

    Attributes:
        state_path (Path): JSON the fixture re-reads on every request.
        log_path (Path): JSONL request log.
    """

    state_path: Path
    log_path: Path

    def set(
        self,
        anthropic: tuple[float, float] | None = None,
        codex: tuple[float, float] | None = None,
        *,
        mode: str = "ok",
        statuses: tuple[str, str] = ("available", "available"),
    ) -> None:
        """Rewrite the state; a `None` provider is omitted from `snapshots` (missing data).

        Parameters:
            anthropic (tuple[float, float] | None): used percents of the Anthropic 5h and weekly windows.
            codex (tuple[float, float] | None): same for OpenAI Codex.
            mode (str): `ok`, `hang` or `error`.
            statuses (tuple[str, str]): snapshot status for Anthropic and Codex.
        """
        snapshots = [
            snapshot(provider, used, status=status)
            for provider, used, status in (
                ("anthropic", anthropic, statuses[0]),
                ("openai-codex", codex, statuses[1]),
            )
            if used is not None
        ]
        self.state_path.write_text(json.dumps({"mode": mode, "snapshots": snapshots, "blocks": []}))

    def requests(self) -> list[dict[str, Any]]:
        """Return the logged requests, oldest first.

        Returns:
            list[dict[str, Any]]: `{t, refresh}` per `router:rpc:usage` request.
        """
        return read_request_log(self.log_path)


def read_request_log(path: Path) -> list[dict[str, Any]]:
    """Parse a fixture request log; a missing file is no requests.

    Parameters:
        path (Path): the JSONL log.

    Returns:
        list[dict[str, Any]]: one entry per line.
    """
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def install_usage_fixture(box: Sandbox, *, keep_router: bool = False) -> UsageFixture:
    """Prepare a sandbox for the fixture: initial state, and the real router package removed.

    The real router answers `router:rpc:usage` too (from empty caches), which would race the fixture.

    Parameters:
        box (Sandbox): sandbox to patch.
        keep_router (bool): leave `pi-subscription-router` configured.

    Returns:
        UsageFixture: handle for state and log.
    """
    fixture = UsageFixture(box.root / "usage-state.json", box.root / "usage-requests.jsonl")
    fixture.set()
    if not keep_router:
        packages = box.settings().get("packages", [])
        router = find_package(ROUTER_PACKAGE, packages, box.agent_dir)
        kept = [
            p
            for p in packages
            if package_directory(str(p.get("source", "") if isinstance(p, dict) else p), box.agent_dir)
            != router
        ]
        settings = box.settings() | {"packages": kept}
        box.settings_path.write_text(json.dumps(settings, indent=2))
    return fixture


def fixture_env(fixture: UsageFixture | None, timers: dict[int, int] | None = None) -> dict[str, str]:
    """Environment for a pane running the fixture.

    Parameters:
        fixture (UsageFixture | None): state and log locations; `None` sets only the timers.
        timers (dict[int, int] | None): timer delay map for `fast_timers.mjs`; `None` keeps real time.

    Returns:
        dict[str, str]: variables to pass to `launch_tui(env=...)`.
    """
    env = (
        {"HARNESS_USAGE_STATE": str(fixture.state_path), "HARNESS_USAGE_LOG": str(fixture.log_path)}
        if fixture
        else {}
    )
    if timers:
        env |= {
            "HARNESS_TIMER_MAP": json.dumps({str(k): v for k, v in timers.items()}),
            "NODE_OPTIONS": f"--import {FAST_TIMERS_PRELOAD}",
        }
    return env


def parse_quota_row(screen: str) -> dict[str, dict[str, str]] | None:
    """Parse the quota row of a plain capture.

    Parameters:
        screen (str): plain pane capture.

    Returns:
        dict[str, dict[str, str]] | None: provider -> `{window label: "NN%" | "--"}`; `None` when no
        quota row is on screen. A provider segment keeps its raw text under the `_raw` key.
    """
    match = ROW_PATTERN.search(screen)
    if match is None:
        return None
    parsed: dict[str, dict[str, str]] = {}
    for segment in match.group("body").split("|"):
        words = segment.strip().split(None, 1)
        if not words or words[0] not in PROVIDERS:
            continue
        rest = words[1] if len(words) > 1 else ""
        parsed[PROVIDERS[words[0]]] = {m["label"]: m["value"] for m in PAIR_PATTERN.finditer(rest)} | {
            "_raw": rest
        }
    return parsed


def values(row: dict[str, dict[str, str]], provider: str) -> list[str]:
    """Return a provider's window values in display order (`NN%` or `--`).

    Parameters:
        row (dict[str, dict[str, str]]): output of `parse_quota_row`.
        provider (str): `anthropic` or `openai-codex`.

    Returns:
        list[str]: values, 5h first.
    """
    return [value for label, value in row[provider].items() if label != "_raw"]


def sgr_by_percent(styled: str) -> dict[int, str]:
    """Map each `NN%` on the quota row of a styled capture to the style in effect at it.

    The style is the last SGR sequence seen before the value, so a coloured value reads as its colour
    and the next plain one as the reset that closed it.

    Parameters:
        styled (str): capture with escape sequences.

    Returns:
        dict[int, str]: percent -> last SGR sequence; empty when there is no quota row.
    """
    for line in styled.splitlines():
        if not ROW_PREFIX_PATTERN.search(ANSI_PATTERN.sub("", line)):
            continue
        style = ""
        found: dict[int, str] = {}
        for token in TOKEN_PATTERN.finditer(line):
            if token.group("sgr"):
                style = token.group("sgr")
            else:
                found[int(token.group("pct"))] = style
        return found
    return {}
