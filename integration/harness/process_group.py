"""Owned process-group signalling and liveness, shared by headless runs and installer cleanup.

Policy: `ESRCH` means the group is gone. macOS answers `EPERM` for a group whose members are
all zombies (an exited leader nobody has reaped yet). That refusal counts as gone only when a
`/bin/ps` listing shows no live member, because zombies cannot fork or write. `EPERM` with a
live member, or one a failed listing cannot explain, surfaces: a refusal is never read as reaped.

References:
- https://man.freebsd.org/cgi/man.cgi?query=ps (`pgid`, `stat` keywords)
- https://man.freebsd.org/cgi/man.cgi?query=killpg (`EPERM`, `ESRCH`)
"""

from __future__ import annotations

import os
import signal
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


def kill_owned_group(pgid: int, timeout: float) -> bool:
    """SIGKILL an owned process group under the module's `EPERM` policy.

    Precondition: the caller created the group and has not reaped its leader, so the unreaped
    leader still reserves `pgid` and it cannot name a foreign, reused group.

    Parameters:
        pgid (int): process group created by the caller; its leader's pid.
        timeout (float): `/bin/ps` deadline in seconds, used only to explain an `EPERM`.

    Returns:
        bool: the group is gone (`ESRCH`, or `EPERM` with no live member); `False` when the
            signal was delivered and members may still be exiting.

    Raises:
        ValueError: `pgid` is 0 or 1, which would signal the caller's own group or broadcast.
        PermissionError: refused while a live member remains, or while the listing failed; in
            that case it is chained to the listing failure.
    """
    if pgid <= 1:
        raise ValueError(f"Refusing to signal process group {pgid}")
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        return True
    except PermissionError as refused:
        try:
            live = group_has_live_members(pgid, timeout)
        except (OSError, subprocess.SubprocessError) as listing:
            raise refused from listing
        if live:
            raise
        return True
    return False
