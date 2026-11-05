"""Shared diagnostic publication policy, including release URL/proxy credential handling.

Signature policy originates in the standalone failure collector proposed in PR #191;
collectors must import this helper rather than maintain independent signature regexes.

References:
- https://github.com/nredd/pi-harness/pull/191
"""

from __future__ import annotations

import argparse
import logging
import re
from pathlib import Path
from typing import TYPE_CHECKING

from harness.release import redact_diagnostic

if TYPE_CHECKING:
    from collections.abc import Sequence

LOGGER = logging.getLogger(__name__)

CREDENTIAL = re.compile(
    rb"(?:npm_[A-Za-z0-9]{36,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|"
    rb"(?:sk|pk)-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|"
    rb"-----BEGIN [A-Z ]*PRIVATE KEY-----|"
    rb"\b(?i:Bearer)[ \t]+[^\s\"']+|"
    rb'"(?:access_token|refresh_token|api_key)"\s*:\s*"[^"]+")'
)


def require_safe_diagnostic(data: bytes) -> None:
    """Refuse unsafe raw bytes without altering them or disclosing credential values.

    Parameters:
        data (bytes): complete candidate content, including non-UTF-8 diagnostics.

    Raises:
        ValueError: a credential signature or release-policy redaction is detected.
    """
    text = data.decode("utf-8", errors="surrogateescape")
    if CREDENTIAL.search(data) or redact_diagnostic(text) != text:
        raise ValueError("Diagnostic publication refused by the shared credential policy")


def main(argv: Sequence[str] | None = None) -> int:
    """Scan shell-collected diagnostic files with the shared policy before a collector exports them.

    Parameters:
        argv (Sequence[str] | None): file paths; `None` reads `sys.argv`.

    Returns:
        int: 0 when every file is safe, 1 when any file is refused or unreadable. Never prints content.
    """
    parser = argparse.ArgumentParser(description=main.__doc__)
    parser.add_argument("paths", nargs="+", type=Path)
    opts = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    for path in opts.paths:
        try:
            require_safe_diagnostic(path.read_bytes())
        except (OSError, ValueError) as error:
            LOGGER.error(f"Refused diagnostic '{path}': {type(error).__name__}")
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
