"""Independent synthetic coverage evidence and caller plan.

References:
    https://github.com/nredd/pi-harness/issues/1001
"""

from __future__ import annotations

from typing import Any


def document() -> dict[str, Any]:
    """Return a small independent measured summary with native-style unsupported counters.

    Parameters:
        None.

    Returns:
        dict[str, Any]: The boundary contract is satisfied.

    Raises:
        None.
    """
    return {
        "os": "linux",
        "measurement_only": False,
        "packages": {
            "pkg/primary": {"lines": 10, "uncovered_lines": 2, "functions": 0, "uncovered_functions": 0}
        },
        "signals": {
            "pkg/primary": {
                "enforcement": "enforced",
                "reason": "",
                "reference": {"lines": 3},
                "delta": {"lines": -1},
            }
        },
        "files": [
            {
                "package": "pkg",
                "signal": "primary",
                "os": "linux",
                "file": "src/a.py",
                "lines": 10,
                "uncovered_lines": 2,
            }
        ],
        "errors": [],
        "not_measured": {"native": "No native branch producer"},
    }


def plan(state: str = "available") -> dict[str, Any]:
    """Return a trusted caller plan independent of the measured summary.

    Parameters:
        state (str): Boundary input.

    Returns:
        dict[str, Any]: The boundary contract is satisfied.

    Raises:
        None.
    """
    return {
        "state": state,
        "signals": {
            "pkg/primary": {
                "enforcement": "enforced",
                "reason": "reason",
                "semantics": "coverage.py/7:lines",
                "state": "planned",
            }
        },
    }
