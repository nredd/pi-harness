"""Keep the Windows OS runtime location without admitting tool configuration or credentials.

References:
    https://github.com/nredd/pi-harness/issues/696
    https://github.com/nredd/pi-harness/actions/runs/43362875064
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from harness import release

if TYPE_CHECKING:
    from pathlib import Path


def test_shared_child_environment_retains_systemroot_without_other_runtime_or_auth_state(
    tmp_path: Path,
) -> None:
    """Prevent the native GetAddrInfoW refusal demonstrated by the isolated verifier fixture.

    This is a portable filter-contract test, not native Windows execution. The referenced native
    fixture independently established baseline refusal and real signature acceptance with only
    SYSTEMROOT restored and the complete signer/ref/self-hosted-runner policy unchanged.

    Parameters:
        tmp_path (Path): Synthetic OS-location fixture, not the actual workstation environment.
    """
    system_root = tmp_path / "Windows"
    system_root.mkdir()
    forbidden = {
        "GH_TOKEN": "synthetic-token",
        "GITHUB_TOKEN": "synthetic-token",
        "GH_DEBUG": "api",
        "NODE_OPTIONS": "--require synthetic-injection.js",
        "BASH_ENV": "synthetic-injection.sh",
        "LOCALAPPDATA": "synthetic-private-cache",
        "USERPROFILE": "synthetic-private-home",
    }
    child = release.child_environment({"PATH": os.defpath, "SYSTEMROOT": str(system_root)} | forbidden)
    assert child["SYSTEMROOT"] == str(system_root)
    assert not (forbidden.keys() & child.keys())
    assert "SYSTEMROOT" not in release.child_environment({"PATH": os.defpath})
