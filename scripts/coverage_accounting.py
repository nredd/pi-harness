"""Validate independent LCOV signals against an owned-source inventory and git ratchet.

References:
    https://github.com/linux-test-project/lcov/blob/master/man/geninfo.1
    ../docs/coverage.md
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

LOGGER = logging.getLogger(__name__)
GIT = Path("/usr/bin/git")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Counts(StrictModel):
    lines: int = Field(ge=0)
    functions: int = Field(ge=0)


class Exclusion(StrictModel):
    path: str = Field(min_length=1)
    kind: Literal["generated", "type-only"]
    reason: str = Field(min_length=1)

    @model_validator(mode="after")
    def meaningful_reason(self) -> Exclusion:
        """Reject whitespace-only explanations."""
        if not self.reason.strip():
            raise ValueError("An exclusion requires a reason")
        return self


class Signal(StrictModel):
    report: str
    files: list[str] | None = None
    max_uncovered: Counts
    reporters: list[str]

    @model_validator(mode="after")
    def text_and_lcov(self) -> Signal:
        """Require visible threshold enforcement as well as machine accounting."""
        if not {"text", "lcov"}.issubset(self.reporters):
            raise ValueError("Coverage signals require both text and lcov reporters")
        if self.files is not None and (not self.files or len(set(self.files)) != len(self.files)):
            raise ValueError("Duplicate signal files")
        return self


class Package(StrictModel):
    root: str
    owned: list[str] = Field(min_length=1)
    exclusions: list[Exclusion]
    test_helpers: list[str] = Field(default_factory=list)
    status: Literal["measured", "pending"]
    note: str
    signals: dict[str, Signal]

    @model_validator(mode="after")
    def measurement_status(self) -> Package:
        """Pending packages must be explicitly explained, never silently green."""
        if self.status == "pending" and (not self.note.strip() or self.signals):
            raise ValueError("Pending package requires a note and no invented measurements")
        if self.status == "measured" and "primary" not in self.signals:
            raise ValueError("Measured package requires a primary signal")
        return self


class Policy(StrictModel):
    version: Literal[1]
    target: Counts
    enforce_target: bool
    packages: dict[str, Package]

    @model_validator(mode="after")
    def zero_target(self) -> Policy:
        """Keep the final target explicit during transitional ratcheting."""
        if self.target.lines or self.target.functions:
            raise ValueError("The target must be zero uncovered lines and functions")
        return self


@dataclass(frozen=True)
class FileCoverage:
    """Validated executable counters for one source file."""

    lines: int
    uncovered_lines: int
    functions: int
    uncovered_functions: int
    branches: int
    uncovered_branches: int


@dataclass
class LcovRecord:
    """Accumulate one LCOV source record without merging independent counters."""

    lines: dict[int, int] = field(default_factory=dict)
    definitions: dict[str, int] = field(default_factory=dict)
    functions: dict[str, int] = field(default_factory=dict)
    branches: dict[str, int] = field(default_factory=dict)
    summaries: dict[str, int] = field(default_factory=dict)

    def add(self, row: str) -> None:
        """Validate a supported LCOV row before adding its counter."""
        key, separator, value = row.partition(":")
        if not separator:
            raise ValueError(f"Malformed LCOV row: '{row}'")
        if key in {"LF", "LH", "FNF", "FNH", "BRF", "BRH"}:
            if key in self.summaries or not value.isdecimal():
                raise ValueError(f"Malformed or duplicate LCOV summary: '{row}'")
            self.summaries[key] = int(value)
        elif key == "DA":
            parts = value.split(",")
            if len(parts) not in {2, 3} or not all(p.isdecimal() for p in parts[:2]):
                raise ValueError(f"Malformed line counter: '{row}'")
            number, count = map(int, parts[:2])
            if number < 1 or number in self.lines:
                raise ValueError(f"Invalid or duplicate line: '{row}'")
            self.lines[number] = count
        elif key in {"FN", "FNDA"}:
            self.add_function(key, value)
        elif key == "BRDA":
            self.add_branch(value)
        else:
            raise ValueError(f"Unsupported LCOV row: '{row}'")

    def add_function(self, key: str, value: str) -> None:
        """Validate named function definitions and hit counts."""
        number, comma, name = value.partition(",")
        if not comma or not number.isdecimal() or not name:
            raise ValueError(f"Malformed function counter: '{value}'")
        counters = self.definitions if key == "FN" else self.functions
        if name in counters:
            raise ValueError(f"Duplicate function counter: '{value}'")
        counters[name] = int(number)

    def add_branch(self, value: str) -> None:
        """Validate a branch identity and its optional hit count."""
        parts = value.split(",")
        if len(parts) != 4 or not all(p.isdecimal() for p in parts[:3]):
            raise ValueError(f"Malformed branch counter: '{value}'")
        identity = ",".join(parts[:3])
        if identity in self.branches or (parts[3] != "-" and not parts[3].lstrip("-").isdecimal()):
            raise ValueError(f"Duplicate or malformed branch: '{value}'")
        self.branches[identity] = 0 if parts[3] == "-" else int(parts[3])

    def finish(self) -> FileCoverage:
        """Check producer summaries against actual executable counters."""
        if set(self.definitions) != set(self.functions):
            raise ValueError("Missing function counters")
        totals = {
            "LF": len(self.lines),
            "LH": sum(value > 0 for value in self.lines.values()),
            "FNF": len(self.functions),
            "FNH": sum(value > 0 for value in self.functions.values()),
            "BRF": len(self.branches),
            "BRH": sum(value > 0 for value in self.branches.values()),
        }
        # LCOV permits aggregate-only function counters. Validate detailed identities
        # when present, otherwise require a consistent nonnegative aggregate pair.
        if not self.functions and not self.definitions:
            totals["FNF"] = self.summaries.get("FNF", 0)
            totals["FNH"] = self.summaries.get("FNH", 0)
            if totals["FNH"] > totals["FNF"]:
                raise ValueError("Inconsistent LCOV function totals")
        if any(value != totals[key] for key, value in self.summaries.items()):
            raise ValueError("Inconsistent LCOV totals")
        if not {"LF", "LH", "FNF", "FNH"}.issubset(self.summaries):
            raise ValueError("Missing LCOV totals")
        return FileCoverage(
            totals["LF"],
            totals["LF"] - totals["LH"],
            totals["FNF"],
            totals["FNF"] - totals["FNH"],
            totals["BRF"],
            totals["BRF"] - totals["BRH"],
        )


def parse_lcov(text: str) -> dict[str, FileCoverage]:
    """Parse LCOV strictly, checking counters rather than trusting summary fields.

    Parameters:
        text (str): Complete LCOV document.
    Returns:
        dict[str, FileCoverage]: Records keyed by the original source path.
    Raises:
        ValueError: Empty, truncated, duplicate or inconsistent data.
    """
    records: dict[str, FileCoverage] = {}
    source: str | None = None
    record = LcovRecord()
    for row in text.splitlines():
        if row.startswith("TN:") and source is None:
            continue
        if row.startswith("SF:"):
            if source is not None or not row[3:] or row[3:] in records:
                raise ValueError("Duplicate or nested LCOV source record")
            source = row[3:]
            record = LcovRecord()
            continue
        if source is None:
            raise ValueError(f"LCOV data outside a source record: '{row}'")
        if row == "end_of_record":
            records[source] = record.finish()
            source = None
            continue
        record.add(row)
    if source is not None or not records or not sum(c.lines for c in records.values()):
        raise ValueError("Empty, zero-line or truncated LCOV report")
    return records


def is_test_path(path: Path) -> bool:
    """Tests and their dedicated helper directories are outside production scope by definition."""
    return any(
        part in {"test", "tests", ".test-support", "fixtures"} for part in path.parts
    ) or path.name.endswith(".test.ts")


def inventory(root: Path, package: Package) -> set[str]:
    """Expand explicit production globs and justified exclusions relative to a package."""
    owned: set[str] = set()
    directory = root / package.root
    for pattern in package.owned:
        matches = {
            p.relative_to(directory).as_posix()
            for p in directory.glob(pattern)
            if p.is_file() and not is_test_path(p.relative_to(directory))
        }
        if not matches:
            raise ValueError(f"Owned pattern matches no files: '{package.root}/{pattern}'")
        owned |= matches
    if any(Path(file).full_match(pattern) for file in owned for pattern in package.test_helpers):
        raise ValueError("Test helper paths overlap the declared production inventory")
    for exclusion in package.exclusions:
        if exclusion.kind == "type-only" and exclusion.path not in owned:
            raise ValueError(f"Exclusion is not in owned inventory: '{exclusion.path}'")
        owned = {file for file in owned if not Path(file).full_match(exclusion.path)}
    return owned


def check_ratchet(current: Policy, base: Policy) -> None:
    """Reject removed signals/packages or an increased uncovered budget versus PR base."""
    if base.enforce_target and not current.enforce_target:
        raise ValueError("Cannot disable global target")
    for name, previous in base.packages.items():
        if name not in current.packages:
            raise ValueError(f"Removed package: '{name}'")
        package = current.packages[name]
        for signal_name, old in previous.signals.items():
            if signal_name not in package.signals:
                raise ValueError(f"Removed signal: '{name}/{signal_name}'")
            new = package.signals[signal_name]
            if (
                new.max_uncovered.lines > old.max_uncovered.lines
                or new.max_uncovered.functions > old.max_uncovered.functions
            ):
                raise ValueError(f"Ratchet violation: '{name}/{signal_name}'")


def scoped_records(root: Path, policy: Policy, package: Package, signal: Signal) -> dict[str, FileCoverage]:
    """Validate raw LCOV paths, removing only defined tests and inventoried sibling source."""
    expected = set(signal.files) if signal.files is not None else inventory(root, package)
    raw = parse_lcov((root / package.root / signal.report).read_text())
    records: dict[str, FileCoverage] = {}
    known = {
        (root / other.root / file).resolve()
        for other in policy.packages.values()
        for file in inventory(root, other) | set(other.test_helpers)
    }
    for path, counters in raw.items():
        resolved = (Path(path) if Path(path).is_absolute() else root / package.root / path).resolve()
        repository_path = resolved.relative_to(root.resolve())
        if "node_modules" in repository_path.parts or is_test_path(repository_path):
            continue
        excluded = any(
            resolved.is_relative_to((root / other.root).resolve())
            and any(
                resolved.relative_to((root / other.root).resolve()).full_match(item.path)
                for item in other.exclusions
            )
            for other in policy.packages.values()
        )
        if excluded:
            continue
        if not resolved.is_relative_to((root / package.root).resolve()):
            if resolved in known:
                continue
            raise ValueError(f"Report file not in policy: '{repository_path}'")
        relative = resolved.relative_to((root / package.root).resolve()).as_posix()
        if any(Path(relative).full_match(pattern) for pattern in package.test_helpers):
            continue
        if relative not in expected:
            raise ValueError(f"Report file not in policy: '{relative}'")
        if relative in records:
            raise ValueError(f"Duplicate normalized source: '{relative}'")
        records[relative] = counters
    missing = expected - records.keys()
    if missing:
        raise ValueError(f"Expected files missing: '{sorted(missing)}'")
    if not sum(c.lines for c in records.values()):
        raise ValueError("Zero total owned lines")
    return records


def account(root: Path, policy: Policy) -> tuple[list[dict[str, object]], list[str]]:
    """Report independent package/file integer counters; retain every failure for artifacts."""
    results: list[dict[str, object]] = []
    errors: list[str] = []
    for name, package in policy.packages.items():
        if package.status == "pending":
            LOGGER.warning(f"NOT MEASURED, TRACKED: '{name}': {package.note}")
            if policy.enforce_target:
                errors.append(f"Unmeasured package: '{name}'")
            continue
        owned = inventory(root, package)
        for signal_name, signal in package.signals.items():
            label = f"{name}/{signal_name}"
            try:
                expected = set(signal.files) if signal.files is not None else owned
                if not expected.issubset(owned):
                    raise ValueError("Signal files are outside owned inventory")
                if signal_name == "primary" and expected != owned:
                    raise ValueError("Primary signal must measure every owned executable file")
                records = scoped_records(root, policy, package, signal)
                uncovered_lines = sum(c.uncovered_lines for c in records.values())
                uncovered_functions = sum(c.uncovered_functions for c in records.values())
                budget = (
                    policy.target
                    if policy.enforce_target and signal_name == "primary"
                    else signal.max_uncovered
                )
                for path, counters in sorted(records.items()):
                    item = {"package": name, "signal": signal_name, "file": path} | vars(counters)
                    results.append(item)
                    LOGGER.info(f"{label} {path}: {counters}")
                LOGGER.info(f"{label}: uncovered lines={uncovered_lines}, functions={uncovered_functions}")
                if uncovered_lines > budget.lines or uncovered_functions > budget.functions:
                    raise ValueError(
                        f"Budget exceeded: {uncovered_lines} lines, {uncovered_functions} functions"
                    )
            except (OSError, ValueError) as error:
                errors.append(f"{label}: {error}")
    return results, errors


def main() -> int:
    """Load the policy and trusted Git base, then write a summary even on accounting failure."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--base", required=True)
    parser.add_argument("--summary", type=Path, default=Path("coverage/summary.json"))
    args = parser.parse_args()
    root = args.root.resolve()
    errors: list[str] = []
    results: list[dict[str, object]] = []
    pending: dict[str, str] = {}
    try:
        policy = Policy.model_validate_json((root / "coverage/policy.json").read_text())
        pending = {
            name: package.note for name, package in policy.packages.items() if package.status == "pending"
        }
        manifest = json.loads((root / "package.json").read_text())
        workspace_roots = {
            path.relative_to(root).as_posix()
            for pattern in manifest["workspaces"]
            for path in root.glob(pattern)
            if (path / "package.json").is_file()
        }
        missing_roots = workspace_roots - {package.root for package in policy.packages.values()}
        if missing_roots:
            raise ValueError(f"Workspaces missing from policy: '{sorted(missing_roots)}'")
        # A new policy has no base counterpart. Only that exact missing path is bootstrap;
        # invalid revisions, failed git commands and malformed base policies still fail closed.
        tree = subprocess.check_output(
            [str(GIT), "-C", str(root), "ls-tree", args.base, "--", "coverage/policy.json"], text=True
        )
        if tree.strip():
            previous = subprocess.check_output(
                [str(GIT), "-C", str(root), "show", f"{args.base}:coverage/policy.json"], text=True
            )
            check_ratchet(policy, Policy.model_validate_json(previous))
        results, errors = account(root, policy)
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        errors.append(str(error))
    totals: dict[str, dict[str, int]] = {}
    for result in results:
        label = f"{result['package']}/{result['signal']}"
        counters = totals.setdefault(label, {})
        for metric in FileCoverage.__dataclass_fields__:
            value = result[metric]
            if isinstance(value, int):
                counters[metric] = counters.get(metric, 0) + value
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(
        json.dumps(
            {"packages": totals, "files": results, "not_measured": pending, "errors": errors}, indent=2
        )
        + "\n"
    )
    for error in errors:
        LOGGER.error(error)
    return int(bool(errors))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    raise SystemExit(main())
