"""Owned process-group liveness, shared by headless runs and installer cleanup.

References:
- https://man.freebsd.org/cgi/man.cgi?query=ps (`pgid`, `stat` keywords)
"""

from __future__ import annotations

import subprocess


def group_has_live_members(pgid: int, timeout: float) -> bool:
    """Check owned-group liveness without mistaking unreaped zombies for writers.

    Parameters:
        pgid (int): process group created by the caller.
        timeout (float): `/bin/ps` deadline in seconds.

    Returns:
        bool: a non-zombie process remains in the group.
    """
    output = subprocess.check_output(["/bin/ps", "-axo", "pgid=,stat="], text=True, timeout=timeout)
    return any(
        fields[0] == str(pgid) and not fields[1].startswith("Z")
        for line in output.splitlines()
        if len(fields := line.split()) == 2
    )
