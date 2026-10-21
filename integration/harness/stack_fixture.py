"""Generate the shared Python/JavaScript canonical-stack fixture."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from harness.stack import Stack, canonical_stack_bytes

FIXTURE_PATH = Path(__file__).resolve().parents[1] / "tests/fixtures/stack-canonical-golden.json"


def golden_stack() -> Stack:
    """Build the edge-case stack used to lock Python/JavaScript canonicalization."""
    return Stack.model_validate(
        {
            "schema_version": 1,
            "name": "personal",
            "core": {
                "integrity": {"pi.tgz": "0" * 64},
                "tag": "v1.3.0-nredd.7",
            },
            "disabled_extensions": {},
            "sources": ["npm:@nredd/pi-preset@0.2.0"],
            "settings": {
                "café": "value 😀",
                "nested": [
                    True,
                    None,
                    2**53 - 1,
                    -(2**53 - 1),
                    {"array": [False, 0, "😀"]},
                ],
                "\x7f": "control\x00\x1f\n\r\t\b\f",
                "\u2028": "line separator",
                "\u2029": "paragraph separator",
                "\ue000": "private-use",
                "\uffff": "last-BMP-key",
                "\U00010000": "astral-key",
            },
        }
    )


def golden_fixture() -> dict[str, str]:
    """Return real producer canonical bytes and their digest as JSON-safe text."""
    contents = canonical_stack_bytes(golden_stack()).decode()
    return {"contents": contents, "sha256": hashlib.sha256(contents.encode()).hexdigest()}


def main() -> None:
    """Write the committed fixture with stable indentation and a trailing newline."""
    FIXTURE_PATH.write_text(f"{json.dumps(golden_fixture(), indent=2, ensure_ascii=True)}\n")


if __name__ == "__main__":
    main()
