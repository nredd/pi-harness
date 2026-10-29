"""Shared diagnostic publication policy, including release URL/proxy credential handling.

Signature policy originates in the standalone failure collector proposed in PR #191;
collectors must import this helper rather than maintain independent signature regexes.

References:
- https://github.com/nredd/pi-harness/pull/191
"""

from __future__ import annotations

import re

from harness.release import redact_diagnostic

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
