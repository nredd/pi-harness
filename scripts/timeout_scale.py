"""Scale selected script subprocess deadlines without changing their defaults.

References:
    https://docs.python.org/3/library/subprocess.html#subprocess.run
"""

from __future__ import annotations

import math
import os


def scaled_timeout(seconds: int) -> float:
    """Apply the optional, bounded `PI_TIMEOUT_SCALE` multiplier.

    Parameters:
        seconds (int): Default deadline in seconds.
    Returns:
        float: Deadline in seconds, scaled by at most 10.
    Raises:
        ValueError: The multiplier is not a finite number at least 1.
    """
    raw = os.environ.get("PI_TIMEOUT_SCALE", "1")
    message = f"`PI_TIMEOUT_SCALE` must be a finite number >= 1; got '{raw}'"
    try:
        scale = float(raw)
    except ValueError as error:
        raise ValueError(message) from error
    if not math.isfinite(scale) or scale < 1:
        raise ValueError(message)
    return seconds * min(scale, 10)
