"""Extract the real setup watchdog shell steps for the hosted control fixture.

References:
    https://github.com/nredd/pi-harness/issues/753
    https://docs.github.com/actions/creating-actions/creating-a-composite-action
"""

from __future__ import annotations

import argparse
import re
import textwrap
from pathlib import Path

RUN_BLOCK = re.compile(r"^      run: \|\n(?P<body>(?:        [^\n]*\n|\n)+)", re.MULTILINE)


def extract_step(source: str, name: str) -> str:
    """Extract one literal shell block, rejecting absent or ambiguous steps.

    Parameters:
        source (str): Composite action source.
        name (str): Exact step name.

    Returns:
        str: Unmodified, dedented shell block.

    Raises:
        ValueError: Step or literal shell block is absent or ambiguous.
    """
    marker = f"    - name: {name}\n"
    if source.count(marker) != 1:
        raise ValueError(f"Expected one step named '{name}'")
    section = source.split(marker, 1)[1].split("\n    - ", 1)[0]
    match = RUN_BLOCK.search(section + "\n")
    if match is None:
        raise ValueError(f"Missing literal shell block for '{name}'")
    return textwrap.dedent(match["body"]).rstrip() + "\n"


def generate(action: Path, destination: Path) -> None:
    """Write the real launch/report blocks with only the fixture deadline shortened.

    Parameters:
        action (Path): Production composite action file.
        destination (Path): Disposable fixture directory.

    Raises:
        ValueError: Production deadline no longer matches the known fixture seam.
    """
    source = action.read_text(encoding="utf-8")
    launch = extract_step(source, "Start WSL setup watchdog")
    if launch.count("$seconds = 300") != 1:
        raise ValueError("Expected one production watchdog deadline")
    report = extract_step(source, "Stop WSL setup watchdog and report")
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "launch.ps1").write_text(
        launch.replace("$seconds = 300", "$seconds = 12"), encoding="utf-8"
    )
    (destination / "report.ps1").write_text(report, encoding="utf-8")


def main() -> None:
    """Generate disposable fixture shells from explicit command-line paths."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    generate(args.action, args.destination)


if __name__ == "__main__":
    main()
