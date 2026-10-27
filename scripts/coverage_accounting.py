"""Validate independent LCOV signals against an owned-source inventory and git ratchet.

References:
    https://github.com/linux-test-project/lcov/blob/master/man/geninfo.1
    ../docs/coverage.md
"""

from __future__ import annotations

import argparse
import difflib
import json
import logging
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

LOGGER = logging.getLogger(__name__)
GIT = Path("/usr/bin/git")


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Counts(StrictModel):
    lines: int = Field(ge=0, description="Maximum number of uncovered executable lines.")
    functions: int = Field(ge=0, description="Maximum number of uncovered functions.")


class Exclusion(StrictModel):
    path: str = Field(min_length=1, description="Package-relative excluded path or generated-file glob.")
    kind: Literal["generated", "type-only", "test-helper"] = Field(description="Reviewed exclusion category.")
    reason: str = Field(min_length=1, description="Why this path is not executable production source.")

    @model_validator(mode="after")
    def meaningful_reason(self) -> Exclusion:
        """Reject whitespace-only explanations.

        Parameters:
            None.
        Returns:
            Exclusion: Validated exclusion declaration.
        Raises:
            ValueError: The reason is blank.
        """
        if not self.reason.strip():
            raise ValueError("An exclusion requires a reason")
        return self


class VerificationHelper(StrictModel):
    path: str = Field(min_length=1, description="Exact repository-relative verification-only file path.")
    reason: str = Field(
        min_length=1, description="Why this file is verification infrastructure, not shipped code."
    )

    @model_validator(mode="after")
    def exact_reasoned_path(self) -> VerificationHelper:
        """Require a concrete, reasoned verification-only classification.

        Parameters:
            None.
        Returns:
            VerificationHelper: Validated exact-file classification.
        Raises:
            ValueError: The reason is blank or the path is absolute, escaping or a wildcard.
        """
        if not self.reason.strip():
            raise ValueError("A `verification_helpers` entry requires a reason")
        if (
            Path(self.path).is_absolute()
            or ".." in Path(self.path).parts
            or any(c in self.path for c in "*?[")
        ):
            raise ValueError(f"Verification helper requires an exact repository-relative path: '{self.path}'")
        return self


class Signal(StrictModel):
    report: str = Field(description="Package-relative LCOV report path.")
    files: list[str] | None = Field(
        default=None, description="Expected source paths; null means full inventory."
    )
    max_uncovered: dict[str, Counts] = Field(
        description="Independent integer uncovered-counter budgets keyed by measured runner OS."
    )
    reporters: list[str] = Field(description="Required producer output formats, including text and LCOV.")

    @model_validator(mode="after")
    def text_and_lcov(self) -> Signal:
        """Require visible threshold enforcement as well as machine accounting.

        Parameters:
            None.
        Returns:
            Signal: Validated independent reporting contract.
        Raises:
            ValueError: Required reporters are absent or file declarations are empty/duplicated.
        """
        if self.max_uncovered.keys() - {"darwin", "linux"}:
            raise ValueError("Coverage floors support only measured darwin/linux OSes")
        if not {"text", "lcov"}.issubset(self.reporters):
            raise ValueError("Coverage signals require both text and lcov reporters")
        if self.files is not None and (not self.files or len(set(self.files)) != len(self.files)):
            raise ValueError("Duplicate signal files")
        return self


class Package(StrictModel):
    root: str = Field(description="Repository-relative package source root.")
    owned: list[str] = Field(
        min_length=1, description="Explicit source paths or package-relative source globs."
    )
    exclusions: list[Exclusion] = Field(description="Reviewed source exclusions with mandatory reasons.")
    test_helpers: list[str] = Field(
        default_factory=list, description="Legacy explicitly named test helper paths."
    )
    status: Literal["measured", "pending"] = Field(description="Whether clean-run coverage is accounted for.")
    note: str = Field(description="Measurement limitations and concrete pending follow-up.")
    signals: dict[str, Signal] = Field(description="Independent primary and compatibility coverage signals.")

    @model_validator(mode="after")
    def measurement_status(self) -> Package:
        """Require explicit measurement status rather than inventing coverage.

        Parameters:
            None.
        Returns:
            Package: Validated package status and signal declarations.
        Raises:
            ValueError: Pending status lacks a note or measured status lacks a primary signal.
        """
        if self.status == "pending" and (not self.note.strip() or self.signals):
            raise ValueError("Pending package requires a note and no invented measurements")
        if self.status == "measured" and "primary" not in self.signals:
            raise ValueError("Measured package requires a primary signal")
        return self


class Reclassification(StrictModel):
    package: str = Field(min_length=1, description="Package whose previous source membership changes.")
    signal: str = Field(default="owned", description="Owned inventory or an independent signal name.")
    path: str = Field(min_length=1, description="Exact repository-relative path in the base inventory.")
    replacement: str | None = Field(
        default=None, description="Current repository-relative replacement, if moved."
    )
    reason: str = Field(
        min_length=1, description="Reviewed justification for removal, exclusion or reclassification."
    )

    @model_validator(mode="after")
    def explicit_paths(self) -> Reclassification:
        """Validate a reasoned, exact source-membership change.

        Parameters:
            None.
        Returns:
            Reclassification: Validated change declaration.
        Raises:
            ValueError: A reason is blank or a path is not repository-relative.
        """
        if not self.reason.strip():
            raise ValueError("A `reclassification` requires a reason")
        for value in [self.path, *([self.replacement] if self.replacement is not None else [])]:
            if Path(value).is_absolute() or ".." in Path(value).parts:
                raise ValueError(f"Reclassification path must be repository-relative: '{value}'")
        return self


class Policy(StrictModel):
    version: Literal[2] = Field(description="Coverage policy schema version; per-OS budgets.")
    target: Counts = Field(description="Final zero-uncovered primary coverage target.")
    enforce_target: bool = Field(
        description="Enable the final primary target instead of transitional budgets."
    )
    packages: dict[str, Package] = Field(description="Named owned source packages and their coverage policy.")
    verification_helpers: list[VerificationHelper] = Field(
        default_factory=list,
        description="Per-file reasoned verification harness classifications, never production.",
    )
    reclassifications: list[Reclassification] = Field(
        default_factory=list,
        description="Explicit reviewed source-membership changes relative to the PR base.",
    )

    @model_validator(mode="after")
    def zero_target(self) -> Policy:
        """Keep the final target explicit during transitional ratcheting.

        Parameters:
            None.
        Returns:
            Policy: Validated zero-uncovered final target.
        Raises:
            ValueError: Either final target counter is nonzero.
        """
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
        """Validate a supported LCOV row before adding its counter.

        Parameters:
            row (str): One LCOV counter or summary row.
        Returns:
            None: The validated counter is accumulated.
        Raises:
            ValueError: The row is malformed, unsupported or duplicated.
        """
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
        """Validate named function definitions and hit counts.

        Parameters:
            key (str): FN definition or FNDA counter identifier.
            value (str): Numeric location/count followed by the function identity.
        Returns:
            None: The validated function record is accumulated.
        Raises:
            ValueError: A function record is malformed or duplicated.
        """
        number, comma, name = value.partition(",")
        if not comma or not number.isdecimal() or not name:
            raise ValueError(f"Malformed function counter: '{value}'")
        counters = self.definitions if key == "FN" else self.functions
        if name in counters:
            raise ValueError(f"Duplicate function counter: '{value}'")
        counters[name] = int(number)

    def add_branch(self, value: str) -> None:
        """Validate a branch identity and its optional hit count.

        Parameters:
            value (str): LCOV branch location, identity and optional hit count.
        Returns:
            None: The validated branch counter is accumulated.
        Raises:
            ValueError: The branch record is malformed or duplicated.
        """
        parts = value.split(",")
        if len(parts) != 4 or not all(p.isdecimal() for p in parts[:3]):
            raise ValueError(f"Malformed branch counter: '{value}'")
        identity = ",".join(parts[:3])
        if identity in self.branches or (parts[3] != "-" and not parts[3].lstrip("-").isdecimal()):
            raise ValueError(f"Duplicate or malformed branch: '{value}'")
        self.branches[identity] = 0 if parts[3] == "-" else int(parts[3])

    def finish(self) -> FileCoverage:
        """Check producer summaries against actual executable counters.

        Parameters:
            None.
        Returns:
            FileCoverage: Validated executable line, function and branch counters.
        Raises:
            ValueError: Required counters are missing or summary totals are inconsistent.
        """
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
    """Identify conventional tests and dedicated fixture directories.

    Parameters:
        path (Path): Repository- or package-relative source path.
    Returns:
        bool: Whether the path belongs to the defined test-file scope.
    Raises:
        None.
    """
    return (
        any(part in {"test", "tests", ".test-support", "fixtures"} for part in path.parts)
        or path.name.endswith(".test.ts")
        or (path.suffix == ".py" and path.name.startswith("test_"))
    )


def expand_inventory(package: Package, files: set[str]) -> set[str]:
    """Expand production membership against a supplied repository file universe.

    Parameters:
        package (Package): Source patterns and reviewed exclusions.
        files (set[str]): Repository-relative paths from one specific tree.
    Returns:
        set[str]: Package-relative executable source membership.
    Raises:
        ValueError: A pattern is empty, a helper overlaps source, or a declaration exclusion is invalid.
    """
    available = {
        Path(file).relative_to(package.root).as_posix()
        for file in files
        if Path(file).is_relative_to(package.root)
    }
    owned: set[str] = set()
    for pattern in package.owned:
        matches = {
            file for file in available if Path(file).full_match(pattern) and not is_test_path(Path(file))
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


def inventory(root: Path, package: Package) -> set[str]:
    """Expand the current working-tree production inventory.

    Parameters:
        root (Path): Absolute repository root.
        package (Package): Source ownership declaration.
    Returns:
        set[str]: Package-relative executable source membership.
    Raises:
        ValueError: Source ownership or exclusions are invalid.
    """
    files = {
        file.relative_to(root).as_posix()
        for pattern in package.owned
        for file in (root / package.root).glob(pattern)
        if file.is_file()
    }
    return expand_inventory(package, files)


def git_read(root: Path, args: list[str]) -> str:
    """Read Git metadata while preserving failed-command diagnostics.

    Parameters:
        root (Path): Absolute repository root.
        args (list[str]): Git subcommand and arguments, without a shell.
    Returns:
        str: Combined standard output and standard error.
    Raises:
        subprocess.CalledProcessError: Git fails; output contains its diagnostics.
        OSError: The absolute Git executable cannot be invoked.
    """
    return subprocess.check_output([str(GIT), "-C", str(root), *args], text=True, stderr=subprocess.STDOUT)


def repository_files(root: Path, revision: str | None = None) -> set[str]:
    """Enumerate an immutable Git tree or current nonignored working files.

    Parameters:
        root (Path): Absolute repository root.
        revision (str | None): Base commit; null selects tracked and untracked working files.
    Returns:
        set[str]: Existing repository-relative paths, preserving spaces and newlines.
    Raises:
        subprocess.CalledProcessError: The revision or repository cannot be read.
    """
    args = (
        ["ls-tree", "-rz", "--name-only", revision]
        if revision is not None
        else ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]
    )
    files = set(git_read(root, args).split("\0")) - {""}
    return files if revision is not None else {file for file in files if (root / file).is_file()}


def inventory_scopes(
    root: Path, policy: Policy, files: set[str] | None = None
) -> dict[tuple[str, str], set[str]]:
    """Identify physical source membership for every owned and compatibility scope.

    Parameters:
        root (Path): Absolute repository root for current-tree expansion.
        policy (Policy): Policy belonging to the same tree as files.
        files (set[str] | None): Base-tree paths, or null for the working tree.
    Returns:
        dict[tuple[str, str], set[str]]: Repository-relative membership by package and scope.
    Raises:
        ValueError: Ownership expansion or an explicit signal subset is invalid.
    """
    scopes: dict[tuple[str, str], set[str]] = {}
    for name, package in policy.packages.items():
        owned = inventory(root, package) if files is None else expand_inventory(package, files)
        scopes[name, "owned"] = {(Path(package.root) / file).as_posix() for file in owned}
        for signal_name, signal in package.signals.items():
            if signal_name == "primary":
                continue
            expected = set(signal.files) if signal.files is not None else owned
            if not expected.issubset(owned):
                raise ValueError(f"Signal is outside owned inventory: '{name}/{signal_name}'")
            scopes[name, signal_name] = {(Path(package.root) / file).as_posix() for file in expected}
    return scopes


def check_inventory_ratchet(root: Path, current: Policy, base: Policy, revision: str) -> None:
    """Reject lost base-tree source membership without a new reasoned declaration.

    Parameters:
        root (Path): Absolute repository root.
        current (Policy): Current working-tree policy.
        base (Policy): Policy read from the PR base commit.
        revision (str): Immutable Git base tree used to expand the base policy.
    Returns:
        None: All membership losses have explicit reviewed declarations.
    Raises:
        ValueError: A loss is undeclared, a declaration is stale or a replacement is invalid.
        subprocess.CalledProcessError: The base Git tree cannot be read.
    """
    before = inventory_scopes(root, base, repository_files(root, revision))
    after = inventory_scopes(root, current)
    losses = {
        (name, signal, path)
        for (name, signal), files in before.items()
        for path in files - after.get((name, signal), set())
    }
    historical = {entry.model_dump_json() for entry in base.reclassifications}
    declarations: dict[tuple[str, str, str], Reclassification] = {}
    for entry in current.reclassifications:
        if entry.model_dump_json() in historical:
            continue
        key = (entry.package, entry.signal, entry.path)
        if key in declarations or key not in losses:
            raise ValueError(f"Duplicate or stale `reclassification`: '{key}'")
        if entry.replacement is not None and entry.replacement not in after.get(key[:2], set()):
            raise ValueError(f"Replacement is outside current inventory: '{entry.replacement}'")
        declarations[key] = entry
    missing = losses - declarations.keys()
    if missing:
        raise ValueError(f"Inventory ratchet requires `reclassifications`: '{sorted(missing)}'")


def audit_inventory(root: Path, policy: Policy, files: set[str]) -> set[str]:
    """Find owned executable TS, Python and JavaScript absent from reviewed scope.

    Parameters:
        root (Path): Absolute repository root.
        policy (Policy): Current measured and pending source declarations.
        files (set[str]): Repository-wide nonignored working paths, including new files.
    Returns:
        set[str]: Unaccounted executable source paths; an empty set passes the audit.
    Raises:
        ValueError: Ownership expansion fails or helper paths are absent, duplicated or production-owned.
    """
    covered = {file for files_in_scope in inventory_scopes(root, policy).values() for file in files_in_scope}
    helpers = {helper.path for helper in policy.verification_helpers}
    if len(helpers) != len(policy.verification_helpers):
        raise ValueError("Duplicate `verification_helpers` paths")
    if helpers - files:
        raise ValueError(
            f"Verification helpers do not exist in the working tree: '{sorted(helpers - files)}'"
        )
    if helpers & covered:
        raise ValueError(f"Verification helpers overlap production inventory: '{sorted(helpers & covered)}'")
    unknown: set[str] = set()
    for file in files:
        path = Path(file)
        if (
            path.suffix not in {".ts", ".py", ".mjs", ".cjs", ".js"}
            or is_test_path(path)
            or path.parts[0] == "forks"
        ):
            continue
        if file in covered or file in helpers:
            continue
        excluded = any(
            path.is_relative_to(package.root)
            and any(path.relative_to(package.root).full_match(item.path) for item in package.exclusions)
            for package in policy.packages.values()
        )
        if not excluded:
            unknown.add(file)
    return unknown


def check_ratchet(current: Policy, base: Policy) -> None:
    """Reject removed signals/packages or increased uncovered budgets.

    Parameters:
        current (Policy): Current working-tree policy.
        base (Policy): Policy read from the PR base commit.
    Returns:
        None: Every integer budget preserves the base ratchet.
    Raises:
        ValueError: A package/signal disappears, a budget increases or the final target is disabled.
    """
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
            for runner_os, floor in old.max_uncovered.items():
                if runner_os not in new.max_uncovered:
                    raise ValueError(f"Missing OS floor: '{name}/{signal_name}/{runner_os}'")
                budget = new.max_uncovered[runner_os]
                if budget.lines > floor.lines or budget.functions > floor.functions:
                    raise ValueError(f"Ratchet violation: '{name}/{signal_name}/{runner_os}'")


def scoped_records(
    root: Path, policy: Policy, package: Package, signal: Signal, reports_root: Path | None = None
) -> dict[str, FileCoverage]:
    """Validate report membership without merging counters across packages.

    Parameters:
        root (Path): Absolute repository root.
        policy (Policy): Complete owned source policy.
        package (Package): Package whose signal is being accounted for.
        signal (Signal): Independent expected-file and report declaration.
        reports_root (Path | None): Downloaded artifact root, or null for working-tree reports.
    Returns:
        dict[str, FileCoverage]: Package-relative counters for expected executable source.
    Raises:
        OSError: The report cannot be read.
        ValueError: LCOV, membership, expected files or total owned executable lines are invalid.
    """
    expected = set(signal.files) if signal.files is not None else inventory(root, package)
    raw = parse_lcov(((reports_root or root) / package.root / signal.report).read_text())
    records: dict[str, FileCoverage] = {}
    known = {
        (root / other.root / file).resolve()
        for other in policy.packages.values()
        for file in inventory(root, other) | set(other.test_helpers)
    }
    for path, counters in raw.items():
        resolved = (Path(path) if Path(path).is_absolute() else root / package.root / path).resolve()
        repository_path = resolved.relative_to(root.resolve())
        if (
            "node_modules" in repository_path.parts
            or is_test_path(repository_path)
            or repository_path.as_posix() in {helper.path for helper in policy.verification_helpers}
        ):
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


def account(
    root: Path,
    policy: Policy,
    runner_os: str = sys.platform,
    reports_root: Path | None = None,
    measure: bool = False,
) -> tuple[list[dict[str, object]], list[str]]:
    """Account for independent package/file counters and retain signal failures.

    Parameters:
        root (Path): Absolute repository root.
        policy (Policy): Validated coverage inventory and budgets.
        runner_os (str): Measured runner platform; only darwin and linux are supported.
        reports_root (Path | None): Downloaded artifact root, or null for working-tree reports.
        measure (bool): Report validated measurements without enforcing budgets; not a gate.
    Returns:
        tuple[list[dict[str, object]], list[str]]: Per-file metrics and explicit accounting failures.
    Raises:
        ValueError: A package inventory cannot be expanded.
    """
    if runner_os not in {"darwin", "linux"}:
        raise ValueError(f"Coverage is not measured on OS: '{runner_os}'")
    results: list[dict[str, object]] = []
    errors: list[str] = []
    for name, package in policy.packages.items():
        owned = inventory(root, package)
        if package.status == "pending":
            LOGGER.warning(f"NOT MEASURED, TRACKED: '{name}': {package.note}")
            if policy.enforce_target:
                errors.append(f"Unmeasured package: '{name}'")
            continue
        for signal_name, signal in package.signals.items():
            label = f"{name}/{signal_name}"
            try:
                expected = set(signal.files) if signal.files is not None else owned
                if not expected.issubset(owned):
                    raise ValueError("Signal files are outside owned inventory")
                if signal_name == "primary" and expected != owned:
                    raise ValueError("Primary signal must measure every owned executable file")
                if not measure and runner_os not in signal.max_uncovered:
                    raise ValueError(f"Missing OS floor: '{runner_os}'")
                records = scoped_records(root, policy, package, signal, reports_root)
                uncovered_lines = sum(c.uncovered_lines for c in records.values())
                uncovered_functions = sum(c.uncovered_functions for c in records.values())
                for path, counters in sorted(records.items()):
                    item = {"package": name, "signal": signal_name, "os": runner_os, "file": path} | vars(
                        counters
                    )
                    results.append(item)
                    LOGGER.info(f"{label} {path}: {counters}")
                LOGGER.info(
                    f"{label}/{runner_os}: uncovered lines={uncovered_lines}, functions={uncovered_functions}"
                )
                if measure:
                    continue
                budget = (
                    policy.target
                    if policy.enforce_target and signal_name == "primary"
                    else signal.max_uncovered[runner_os]
                )
                if uncovered_lines > budget.lines or uncovered_functions > budget.functions:
                    raise ValueError(
                        f"Budget exceeded: {uncovered_lines} lines, {uncovered_functions} functions"
                    )
            except (OSError, ValueError) as error:
                errors.append(f"{label}: {error}")
    return results, errors


def log_measured_diff(policy: Policy, floors: dict[str, dict[str, dict[str, int]]], runner_os: str) -> None:
    """Print a reviewable policy proposal without editing any checkout files.

    Parameters:
        policy (Policy): Original validated coverage policy.
        floors (dict[str, dict[str, dict[str, int]]]): Validated measured counts by signal and OS.
        runner_os (str): Explicit measured artifact platform.
    Returns:
        None: A unified policy diff is logged for manual review, never applied.
    Raises:
        ValueError: Measured counters cannot be validated as a floor.
    """
    proposed = policy.model_copy(deep=True)
    for label, platforms in floors.items():
        name, signal = label.split("/")
        proposed.packages[name].signals[signal].max_uncovered[runner_os] = Counts.model_validate(
            platforms[runner_os]
        )
    LOGGER.info("MEASUREMENT ONLY; review this diff, no policy files are changed")
    LOGGER.info(
        "".join(
            difflib.unified_diff(
                policy.model_dump_json(indent=2).splitlines(keepends=True),
                proposed.model_dump_json(indent=2).splitlines(keepends=True),
                fromfile="coverage/policy.json",
                tofile=f"measured/{runner_os}/policy.json",
            )
        )
    )


def parse_args() -> argparse.Namespace:
    """Validate gate and measurement modes before reading any reports.

    Parameters:
        None: Arguments are read from the command line.
    Returns:
        argparse.Namespace: Validated CLI inputs.
    Raises:
        SystemExit: Missing base or mixed gate/measurement options are rejected.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--base", help="Git base required for gating; not used by --measure.")
    parser.add_argument("--os", default=sys.platform, choices=["darwin", "linux"])
    parser.add_argument("--reports-root", type=Path, help="Root of downloaded CI artifacts.")
    parser.add_argument("--measure", action="store_true", help="Print measured policy diff; NOT a gate.")
    parser.add_argument("--summary", type=Path, default=Path("coverage/summary.json"))
    args = parser.parse_args()
    if not args.measure and not args.base:
        parser.error("--base is required unless --measure is selected")
    if args.measure and args.base:
        parser.error("--measure cannot enforce --base; use a separate gating invocation")
    return args


def main() -> int:
    """Read CLI inputs, enforce both Git ratchets and write an accounting summary.

    Parameters:
        None: Arguments are read through argparse.
    Returns:
        int: Zero for successful accounting, one for validated input or accounting failures.
    Raises:
        OSError: The summary output cannot be written.
        SystemExit: Argparse rejects the command line.
    """
    args = parse_args()
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
        unknown = audit_inventory(root, policy, repository_files(root))
        if unknown:
            raise ValueError(f"Executable source missing from policy: '{sorted(unknown)}'")
        # A new policy has no base counterpart. Only that exact missing path is bootstrap;
        # invalid revisions, failed git commands and malformed base policies still fail closed.
        tree = "" if args.measure else git_read(root, ["ls-tree", args.base, "--", "coverage/policy.json"])
        if tree.strip():
            previous = git_read(root, ["show", f"{args.base}:coverage/policy.json"])
            base = Policy.model_validate_json(previous)
            check_ratchet(policy, base)
            check_inventory_ratchet(root, policy, base, args.base)
        results, errors = account(root, policy, args.os, args.reports_root, args.measure)
    except subprocess.CalledProcessError as error:
        errors.append(f"Git metadata read failed: '{error.output}'")
    except (OSError, ValueError, KeyError, TypeError) as error:
        errors.append(str(error))
    totals: dict[str, dict[str, int]] = {}
    for result in results:
        label = f"{result['package']}/{result['signal']}"
        counters = totals.setdefault(label, {})
        for metric in FileCoverage.__dataclass_fields__:
            value = result[metric]
            if isinstance(value, int):
                counters[metric] = counters.get(metric, 0) + value
    floors = {
        label: {args.os: {"lines": counts["uncovered_lines"], "functions": counts["uncovered_functions"]}}
        for label, counts in totals.items()
    }
    if args.measure and not errors:
        log_measured_diff(policy, floors, args.os)
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(
        json.dumps(
            {
                "os": args.os,
                "measurement_only": args.measure,
                "measured_floors": floors,
                "packages": totals,
                "files": results,
                "not_measured": pending,
                "errors": errors,
            },
            indent=2,
        )
        + "\n"
    )
    for error in errors:
        LOGGER.error(error)
    return int(bool(errors))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    raise SystemExit(main())
