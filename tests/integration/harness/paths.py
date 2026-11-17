"""Well-known locations and the pi command under test.

References:
- pi agent dir layout: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md
"""

from __future__ import annotations

import os
import platform
import shlex
from pathlib import Path

from pi_release.paths import is_wsl

REPO_ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS_DIR = REPO_ROOT / "artifacts"
GOLDEN_DIR = REPO_ROOT / "golden"
BASELINES_PATH = REPO_ROOT / "baselines" / f"bench.{platform.system().lower()}.json"
PROVIDERS_DIR = REPO_ROOT / "providers"
FAUX_EXTENSION = PROVIDERS_DIR / "faux.ts"
PROBE_EXTENSION = REPO_ROOT / "probes" / "render.ts"
LATENCY_EXTENSION = REPO_ROOT / "probes" / "latency.ts"


def environment_meta() -> dict[str, object]:
    """Describe the machine a baseline is recorded on.

    Returns:
        dict[str, object]: `wsl` and `cpus`; only the OS key is in the baseline file name.
    """
    return {"wsl": is_wsl(), "cpus": os.cpu_count()}


def pi_command() -> list[str]:
    """Return the pi command under test.

    `PI_BIN` overrides it, e.g. `PI_BIN="node ~/code/pi/packages/coding-agent/dist/bundle/cli.js"`
    to verify a staged fork build before tagging. It is split like a shell word list.

    Returns:
        list[str]: argv prefix that launches pi.

    Raises:
        FileNotFoundError: the explicit `PI_BIN` input is unset.
    """
    override = os.environ.get("PI_BIN")
    if override:
        return [str(Path(part).expanduser()) for part in shlex.split(override)]
    raise FileNotFoundError(
        "Set explicit `PI_BIN`, or fetch a core release with `python -m pi_release.release`"
    )
