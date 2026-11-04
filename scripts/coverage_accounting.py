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
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

LOGGER = logging.getLogger(__name__)
GIT = Path("/usr/bin/git")
# Package keys a base policy may still carry after their support was deleted. The current policy
# rejects them (`extra="forbid"`); only the base read drops them, so a ratchet against an older
# commit keeps working. `target_allowances` went with #375, when the last allowance reached 0/0.
# Delete `RETIRED_PACKAGE_KEYS` and `base_policy` once no ratchet base carries `target_allowances`,
# then parse the base with `Policy.model_validate_json` again.
RETIRED_PACKAGE_KEYS = ("target_allowances",)
# Intentionally narrow ESM grammar: no comments, imports, expressions, attributes or declarations.
# These static local named re-exports only link bindings; their targets remain executable inventory.
FACADE_EXPORT = re.compile(
    r"(?:\s*export\s*\{\s*[A-Za-z_$][A-Za-z0-9_$]*"
    r"(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?"
    r"(?:\s*,\s*(?:type\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?)*"
    r"\s*,?\s*\}\s+from\s+(?:\"\./[A-Za-z0-9_./-]+\.[jt]s\"|'\./[A-Za-z0-9_./-]+\.[jt]s')\s*;\s*)+"
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Counts(StrictModel):
    lines: int = Field(ge=0, description="Stored uncovered executable-line budget or advisory reference.")
    functions: int = Field(ge=0, description="Stored uncovered-function budget or advisory reference.")
    branches: int | None = Field(
        default=None,
        ge=0,
        description=(
            "Stored uncovered-branch cap or advisory reference; null only for producers without branch "
            "records or `goal: excluded` packages."
        ),
    )


class Exclusion(StrictModel):
    path: str = Field(min_length=1, description="Package-relative excluded path or generated-file glob.")
    kind: Literal["generated", "type-only", "test-helper", "non-executable-facade"] = Field(
        description="Reviewed exclusion category; facades must pass a strict static re-export grammar."
    )
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
        if self.kind == "non-executable-facade" and (
            Path(self.path).is_absolute()
            or ".." in Path(self.path).parts
            or any(character in self.path for character in "*?[")
            or Path(self.path).suffix != ".ts"
        ):
            raise ValueError("A non-executable facade requires an exact package-relative TypeScript path")
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
        description="Independent integer uncovered-counter budgets or report-only references by measured OS."
    )
    reporters: list[str] = Field(description="Required producer output formats, including text and LCOV.")
    enforcement: Literal["enforced", "report-only"] = Field(
        default="enforced",
        description="Enforce budgets or only report validated counters and reference deltas.",
    )
    reason: str = Field(
        default="", description="Mandatory explanation and migration issue for report-only signals."
    )
    producer: Literal["lcov", "coverage.py"] = Field(
        default="lcov",
        description="Report writer; only coverage.py legitimately writes a bare record for an empty source.",
    )
    skip_hosts: list[str] = Field(
        default_factory=list,
        description="CI hosts whose gate list never runs this signal's producer; reported NOT RUN there.",
    )
    gate: str = Field(
        default="",
        description="Make target producing the report; a run that skips that gate reports it NOT RUN.",
    )

    @model_validator(mode="after")
    def text_and_lcov(self) -> Signal:
        """Require visible threshold enforcement as well as machine accounting.

        Parameters:
            None.
        Returns:
            Signal: Validated independent reporting contract.
        Raises:
            ValueError: A report-only reason, reporters, OS keys or expected-file declarations are invalid.
        """
        if self.enforcement == "report-only" and not self.reason.strip():
            raise ValueError("A report-only signal requires a nonblank `reason`")
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
    goal: Literal["100-percent", "ratchet", "report-only", "excluded"] = Field(
        default="100-percent",
        description=(
            "Owner-approved scope of the global line/function goal. `ratchet` is outside the zero target "
            "but enforced: each enforced signal's per-OS `max_uncovered` is a floor that can only go down."
        ),
    )
    goal_reason: str = Field(default="", description="Required reason for domains outside the global goal.")
    signals: dict[str, Signal] = Field(description="Independent primary and compatibility coverage signals.")

    @model_validator(mode="after")
    def measurement_status(self) -> Package:
        """Require explicit measurement status rather than inventing coverage.

        Parameters:
            None.
        Returns:
            Package: Validated package status and signal declarations.
        Raises:
            ValueError: Pending status is invalid or measured primary enforcement is missing/disabled.
        """
        if self.status == "pending" and (not self.note.strip() or self.signals):
            raise ValueError("Pending package requires a note and no invented measurements")
        if self.status == "measured" and "primary" not in self.signals:
            raise ValueError("Measured package requires a primary signal")
        if self.goal != "100-percent" and not self.goal_reason.strip():
            raise ValueError("Domains outside the global goal require a nonblank `goal_reason`")
        if (
            self.goal == "100-percent"
            and "primary" in self.signals
            and self.signals["primary"].enforcement != "enforced"
        ):
            raise ValueError("Primary signals must remain enforced")
        if self.goal not in {"100-percent", "ratchet"} and any(
            signal.enforcement != "report-only" for signal in self.signals.values()
        ):
            raise ValueError("Signals outside the global goal must remain report-only")
        if self.goal == "ratchet" and (
            self.status != "measured"
            or not any(signal.enforcement == "enforced" for signal in self.signals.values())
        ):
            raise ValueError("A ratchet package must be measured with at least one enforced signal")
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


class EnforcementChange(StrictModel):
    package: str = Field(min_length=1, description="Package whose enforced signal becomes report-only.")
    signal: str = Field(min_length=1, description="Exact signal whose enforcement is explicitly relaxed.")
    reason: str = Field(min_length=1, description="Reviewed reason for this specific enforcement downgrade.")

    @model_validator(mode="after")
    def nonblank_reason(self) -> EnforcementChange:
        """Require a substantive reason separate from the signal's standing note.

        Parameters:
            None.
        Returns:
            EnforcementChange: Validated explicit downgrade declaration.
        Raises:
            ValueError: The reason contains only whitespace.
        """
        if not self.reason.strip():
            raise ValueError("An `enforcement_changes` entry requires a nonblank reason")
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

    enforcement_changes: list[EnforcementChange] = Field(
        default_factory=list,
        description="New reviewed declarations required for enforced-to-report-only signal transitions.",
    )

    @model_validator(mode="after")
    def zero_target(self) -> Policy:
        """Keep the final target explicit during transitional ratcheting.

        Parameters:
            None.
        Returns:
            Policy: Validated zero-uncovered final target.
        Raises:
            ValueError: A final target counter is nonzero.
        """
        if self.target.lines or self.target.functions or self.target.branches:
            raise ValueError("The target must be zero uncovered lines, functions and branches")
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


def split_function_hits(value: str) -> tuple[int, str]:
    """Split an `FNDA` payload, `<hits>,<name>`, in both LCOV dialects.

    Parameters:
        value (str): Text after `FNDA:`.
    Returns:
        tuple[int, str]: Hit count and function identity.
    Raises:
        ValueError: The count is not decimal or the name is empty.
    """
    count, _, name = value.partition(",")
    if not count.isdecimal() or not name:
        raise ValueError(value)
    return int(count), name


def split_function_definition(value: str) -> tuple[int, str]:
    """Split an `FN` payload: `<line>,<name>` (lcov, Istanbul) or `<line>,<end>,<name>` (coverage.py).

    Parameters:
        value (str): Text after `FN:`.
    Returns:
        tuple[int, str]: Start line and function identity.
    Raises:
        ValueError: The line is not decimal or the name is empty.

    `FN:1,2,g` is read as coverage.py's `<line>,<end>,<name>`. A lcov function literally named `2,g`
    cannot occur (identifiers have no comma), and if its `FNDA` disagrees the identities no longer match
    and `finish` fails closed with "Missing function counters".
    """
    line, _, rest = value.partition(",")
    end, comma, named = rest.partition(",")
    name = named if comma and end.isdecimal() else rest
    if not line.isdecimal() or not name:
        raise ValueError(value)
    return int(line), name


@dataclass
class LcovRecord:
    """Accumulate one LCOV source record without merging independent counters."""

    lines: dict[int, int] = field(default_factory=dict)
    definitions: dict[str, int] = field(default_factory=dict)
    functions: dict[str, int] = field(default_factory=dict)
    branches: dict[str, int] = field(default_factory=dict)
    summaries: dict[str, int] = field(default_factory=dict)
    coveragepy: bool = False

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
        try:
            number, name = (split_function_hits if key == "FNDA" else split_function_definition)(value)
        except ValueError as error:
            raise ValueError(f"Malformed function counter: '{value}'") from error
        counters = self.definitions if key == "FN" else self.functions
        if name in counters:
            raise ValueError(f"Duplicate function counter: '{value}'")
        counters[name] = number

    def add_branch(self, value: str) -> None:
        """Validate a branch identity and its optional hit count.

        Parameters:
            value (str): LCOV branch location, identity and optional hit count. coverage.py names the
                branch by its destination (`jump to line 12`) where LCOV has a branch number.
        Returns:
            None: The validated branch counter is accumulated.
        Raises:
            ValueError: The branch record is malformed or duplicated.
        """
        parts = value.split(",")
        if self.coveragepy and len(parts) >= 4:
            head, _, count = value.rpartition(",")
            parts = [*head.split(",", 2), count]
        named = self.coveragepy and bool(parts[2:3]) and bool(parts[2].strip())
        if (
            len(parts) != 4
            or not all(p.isdecimal() for p in parts[:2])
            or not (parts[2].isdecimal() or named)
        ):
            raise ValueError(f"Malformed branch counter: '{value}'")
        identity = ",".join(parts[:3])
        if identity in self.branches or (parts[3] != "-" and not parts[3].lstrip("-").isdecimal()):
            raise ValueError(f"Duplicate or malformed branch: '{value}'")
        self.branches[identity] = 0 if parts[3] == "-" else int(parts[3])

    def finish(self, bare_source: bool = False) -> FileCoverage:
        """Check producer summaries against actual executable counters.

        Parameters:
            bare_source (bool): Accept a record with no rows at all, as coverage.py writes for a source
                without executable lines, and a record with no function rows or totals, as it writes for a
                module without functions. Other producers must emit totals, so either is truncation.
        Returns:
            FileCoverage: Validated executable line, function and branch counters.
        Raises:
            ValueError: Required counters are missing or summary totals are inconsistent.
        """
        if set(self.definitions) != set(self.functions):
            raise ValueError("Missing function counters")
        if bare_source and not (self.lines or self.functions or self.branches or self.summaries):
            return FileCoverage(0, 0, 0, 0, 0, 0)
        if bare_source and not self.definitions and not {"FNF", "FNH"} & self.summaries.keys():
            self.summaries |= {"FNF": 0, "FNH": 0}
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


def parse_lcov(text: str, *, bare_sources: bool = False) -> dict[str, FileCoverage]:
    """Parse LCOV strictly, checking counters rather than trusting summary fields.

    Parameters:
        text (str): Complete LCOV document.
        bare_sources (bool): Read coverage.py's dialect: a bare `SF`/`end_of_record` pair is an empty
            source, a module without functions omits FN totals, and branches are named, not numbered.
    Returns:
        dict[str, FileCoverage]: Records keyed by the original source path.
    Raises:
        ValueError: Empty, truncated, duplicate or inconsistent data.
    """
    records: dict[str, FileCoverage] = {}
    source: str | None = None
    record = LcovRecord(coveragepy=bare_sources)
    for row in text.splitlines():
        if row.startswith("TN:") and source is None:
            continue
        if row.startswith("SF:"):
            if source is not None or not row[3:] or row[3:] in records:
                raise ValueError("Duplicate or nested LCOV source record")
            source = row[3:]
            record = LcovRecord(coveragepy=bare_sources)
            continue
        if source is None:
            raise ValueError(f"LCOV data outside a source record: '{row}'")
        if row == "end_of_record":
            records[source] = record.finish(bare_sources)
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
        if exclusion.kind in {"type-only", "non-executable-facade"} and exclusion.path not in owned:
            raise ValueError(f"Exclusion is not in owned inventory: '{exclusion.path}'")
        owned = {file for file in owned if not Path(file).full_match(exclusion.path)}
    return owned


def inventory(root: Path, package: Package) -> set[str]:
    """Validate facade source shapes and expand the current executable production inventory.

    Parameters:
        root (Path): Absolute repository root.
        package (Package): Source ownership declaration.
    Returns:
        set[str]: Package-relative executable source membership.
    Raises:
        ValueError: Source ownership, exclusions or non-executable facade shapes are invalid.
        OSError: A classified facade cannot be read.
    """
    files = {
        file.relative_to(root).as_posix()
        for pattern in package.owned
        for file in (root / package.root).glob(pattern)
        if file.is_file()
    }
    for exclusion in package.exclusions:
        if exclusion.kind == "non-executable-facade":
            source = (root / package.root / exclusion.path).read_text()
            if FACADE_EXPORT.fullmatch(source) is None:
                raise ValueError(
                    f"Non-executable facade contains more than static re-exports: '{exclusion.path}'"
                )
    return expand_inventory(package, files)


def git_read(root: Path, args: list[str]) -> str:
    """Read explicit-root Git metadata without ambient routing or config injection.

    Parameters:
        root (Path): Absolute repository root.
        args (list[str]): Git subcommand and arguments, without a shell.
    Returns:
        str: Combined standard output and standard error.
    Raises:
        subprocess.CalledProcessError: Git fails; output contains its diagnostics.
        OSError: The absolute Git executable cannot be invoked.
    """
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")} | {
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_CONFIG_GLOBAL": os.devnull,
    }
    return subprocess.check_output(
        [str(GIT), "-C", str(root), *args], text=True, stderr=subprocess.STDOUT, env=env
    )


def base_policy(text: str) -> Policy:
    """Parse a base commit's policy, dropping only package keys whose support was deleted.

    Parameters:
        text (str): `coverage/policy.json` contents read from the base revision.
    Returns:
        Policy: The validated base policy without retired package keys.
    Raises:
        ValueError: The base policy is malformed JSON or fails validation for any other reason.
    """
    data = json.loads(text)
    packages = data.get("packages") if isinstance(data, dict) else None
    for package in packages.values() if isinstance(packages, dict) else ():
        if isinstance(package, dict):
            for key in RETIRED_PACKAGE_KEYS:
                package.pop(key, None)
    return Policy.model_validate_json(json.dumps(data))


def divergence_base(root: Path, reference: str) -> str:
    """Resolve where HEAD diverged from a comparison ref, so newer target-only files are not losses.

    Parameters:
        root (Path): Absolute repository root.
        reference (str): Comparison ref, e.g. `origin/main`.
    Returns:
        str: The single merge base of HEAD and the reference.
    Raises:
        ValueError: The ref is missing or empty, shares no history with HEAD or has several merge bases.
    """
    try:
        bases = git_read(root, ["merge-base", "--all", "--end-of-options", "HEAD", reference]).split()
    except subprocess.CalledProcessError as error:
        detail = error.output.strip() or "no common ancestor"
        raise ValueError(
            f"Cannot resolve the coverage base from '{reference}': '{detail}'. Fetch it or pass `BASE=<sha>`"
        ) from error
    if len(bases) != 1:
        raise ValueError(
            f"Expected one merge base of HEAD and '{reference}', found {len(bases)}: '{sorted(bases)}'"
        )
    LOGGER.info(f"Coverage base: '{bases[0]}', where HEAD diverged from '{reference}'")
    return bases[0]


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


def check_enforcement_changes(current: Policy, base: Policy) -> None:
    """Require fresh, exact declarations for every enforced-to-report-only transition.

    Parameters:
        current (Policy): Current signal enforcement and reviewed change ledger.
        base (Policy): Base-tree enforcement and historical ledger entries.
    Returns:
        None: All downgrades have new, unambiguous reasoned entries.
    Raises:
        ValueError: A downgrade lacks a new entry, or an entry is duplicate or stale.
    """
    downgrades = {
        (name, signal_name)
        for name, package in base.packages.items()
        for signal_name, signal in package.signals.items()
        if signal.enforcement == "enforced"
        and name in current.packages
        and signal_name in current.packages[name].signals
        and current.packages[name].signals[signal_name].enforcement == "report-only"
    }
    historical = {entry.model_dump_json() for entry in base.enforcement_changes}
    declared: set[tuple[str, str]] = set()
    for entry in current.enforcement_changes:
        if entry.model_dump_json() in historical:
            continue
        key = (entry.package, entry.signal)
        if key not in downgrades or key in declared:
            raise ValueError(f"Duplicate or stale `enforcement_changes` entry: '{key}'")
        declared.add(key)
    if downgrades - declared:
        raise ValueError(
            f"Enforcement downgrade requires new `enforcement_changes`: '{sorted(downgrades - declared)}'"
        )


def loosens(budget: Counts, floor: Counts) -> bool:
    """Compare a budget with the base floor it must not exceed, counter by counter.

    Parameters:
        budget (Counts): Current budget.
        floor (Counts): Base budget.
    Returns:
        bool: Whether any counter rises, or a branch cap the base had is dropped.
    Raises:
        None.
    """
    return (
        budget.lines > floor.lines
        or budget.functions > floor.functions
        or (floor.branches is not None and (budget.branches is None or budget.branches > floor.branches))
    )


def check_ratchet(current: Policy, base: Policy) -> None:
    """Ratchet enforced budgets and require explicit declarations for enforcement downgrades.

    Parameters:
        current (Policy): Current working-tree policy.
        base (Policy): Policy read from the PR base commit.
    Returns:
        None: Enforced budgets, OS membership and enforcement declarations preserve the base ratchet.
    Raises:
        ValueError: A measured package is removed, or membership, enforced budgets, enforcement
            transitions or the final target are weakened.
    """
    if base.enforce_target and not current.enforce_target:
        raise ValueError("Cannot disable global target")
    if loosens(current.target, base.target):
        raise ValueError("Cannot remove the branch target")
    check_enforcement_changes(current, base)
    for name, previous in base.packages.items():
        if name not in current.packages:
            # A pending package has no signals, hence no budget to lose; `check_inventory_ratchet`
            # still requires a `reclassifications` entry for each of its sources.
            if previous.status == "pending":
                continue
            raise ValueError(f"Removed package: '{name}'")
        package = current.packages[name]
        graduates = previous.goal == "ratchet" and package.goal == "100-percent"
        if previous.goal in {"100-percent", "ratchet"} and package.goal != previous.goal and not graduates:
            raise ValueError(f"Cannot remove package from global goal: '{name}'")
        for signal_name, old in previous.signals.items():
            if signal_name not in package.signals:
                raise ValueError(f"Removed signal: '{name}/{signal_name}'")
            check_signal_ratchet(f"{name}/{signal_name}", package.signals[signal_name], old)


def check_signal_ratchet(label: str, new: Signal, old: Signal) -> None:
    """Ratchet one signal's hosts, producer gate and per-OS floors against its base declaration.

    Parameters:
        label (str): `package/signal` for error messages.
        new (Signal): Current declaration.
        old (Signal): Base declaration.
    Returns:
        None: The signal preserves the base ratchet.
    Raises:
        ValueError: A host is newly skipped, the gate changes, an OS floor disappears or an enforced
            counter (including a branch cap) is raised or dropped.
    """
    if not set(new.skip_hosts) <= set(old.skip_hosts):
        raise ValueError(f"Cannot add skipped hosts: '{label}'")
    if new.gate != old.gate:
        raise ValueError(f"Cannot change a signal's producer gate: '{label}'")
    for runner_os, floor in old.max_uncovered.items():
        if runner_os not in new.max_uncovered:
            raise ValueError(f"Missing OS floor: '{label}/{runner_os}'")
        if old.enforcement == new.enforcement == "enforced" and loosens(new.max_uncovered[runner_os], floor):
            raise ValueError(f"Ratchet violation: '{label}/{runner_os}'")


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
    raw = parse_lcov(
        ((reports_root or root) / package.root / signal.report).read_text(),
        bare_sources=signal.producer == "coverage.py",
    )
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


def validate_signal_inventory(owned: set[str], signal_name: str, signal: Signal) -> None:
    """Validate expected-source scope independently of whether counts are enforced.

    Parameters:
        owned (set[str]): Complete expanded package-relative production inventory.
        signal_name (str): Primary or independent compatibility signal name.
        signal (Signal): Expected-source subset and enforcement declaration.
    Returns:
        None: Expected files belong to production, with complete enforced primary/Bun scope.
    Raises:
        ValueError: A subset is outside ownership or an enforced complete-source signal is partial.
    """
    expected = set(signal.files) if signal.files is not None else owned
    if not expected.issubset(owned):
        raise ValueError("Signal files are outside owned inventory")
    if signal_name == "primary" and expected != owned:
        raise ValueError("Primary signal must measure every owned executable file")
    if signal_name == "bun" and signal.enforcement == "enforced" and expected != owned:
        raise ValueError("Enforced Bun signal must measure every owned executable file")


def not_run_reason(signal: Signal, host: str | None, skipped_gates: frozenset[str]) -> str:
    """Return why this run has no producer for a signal, or an empty string when the report is required.

    Parameters:
        signal (Signal): Signal declaration.
        host (str | None): CI host class, or null outside CI.
        skipped_gates (frozenset[str]): Make targets this run planned but skipped.
    Returns:
        str: The NOT RUN reason, empty when the signal must be accounted.
    Raises:
        None.
    """
    if host is not None and host in signal.skip_hosts:
        return f"host '{host}' has no producer in that cell"
    if signal.gate and signal.gate in skipped_gates:
        return f"this run skipped its producer gate '{signal.gate}'"
    return ""


def require_declared_gates(policy: Policy, skipped_gates: frozenset[str]) -> None:
    """Reject skipped gates no policy signal declares, so a typo cannot silently skip nothing.

    Parameters:
        policy (Policy): Policy whose signals declare their producer gates.
        skipped_gates (frozenset[str]): Make targets this run planned but skipped.
    Returns:
        None: The gates are all declared.
    Raises:
        ValueError: A skipped gate is declared by no policy signal.
    """
    declared = {signal.gate for package in policy.packages.values() for signal in package.signals.values()}
    undeclared = sorted(skipped_gates - (declared - {""}))
    if undeclared:
        raise ValueError(f"Skipped gates no policy signal declares: {undeclared}")


def check_branch_cap(package: Package, cap: Counts, records: dict[str, FileCoverage]) -> None:
    """Require a branch cap exactly when the producer emits branch records.

    A capped signal whose report has executable lines but no branch records fails closed, so a
    producer that silently stops writing `BRDA` rows can't read as zero uncovered branches.

    Parameters:
        package (Package): Package whose goal may exempt it from branch caps.
        cap (Counts): The signal's declared per-OS budget or reference.
        records (dict[str, FileCoverage]): The signal's validated, scoped report records.
    Returns:
        None: The declared cap matches the producer's branch output.
    Raises:
        ValueError: Branch records have no cap outside `goal: excluded`, or a cap has no branch records.
    """
    branches = sum(counters.branches for counters in records.values())
    if cap.branches is None and branches and package.goal != "excluded":
        raise ValueError(f"Missing branch cap: the report has {branches} branch records")
    if cap.branches is not None and not branches and any(counters.lines for counters in records.values()):
        raise ValueError(
            "Branch producer missing: a branch cap is declared but the report has no BRDA records"
        )


def describe(lines: int, functions: int, branches: int | None) -> str:
    """Format uncovered counters for budget messages.

    Parameters:
        lines (int): Uncovered lines.
        functions (int): Uncovered functions.
        branches (int | None): Uncovered branches, or null when the signal has no branch cap.
    Returns:
        str: Human-readable counter list; branches appear only when capped.
    Raises:
        None.
    """
    return f"{lines} lines, {functions} functions" + ("" if branches is None else f", {branches} branches")


def account(
    root: Path,
    policy: Policy,
    runner_os: str = sys.platform,
    reports_root: Path | None = None,
    measure: bool = False,
    *,
    host: str | None = None,
    skipped_gates: frozenset[str] = frozenset(),
) -> tuple[list[dict[str, object]], list[str]]:
    """Account for independent package/file counters and retain signal failures.

    Parameters:
        root (Path): Absolute repository root.
        policy (Policy): Validated coverage inventory and budgets.
        runner_os (str): Measured runner platform; only darwin and linux are supported.
        reports_root (Path | None): Downloaded artifact root, or null for working-tree reports.
        measure (bool): Report validated measurements without enforcing budgets; not a gate.
        host (str | None): CI host class; signals listing it in `skip_hosts` are reported NOT RUN.
        skipped_gates (frozenset[str]): Make targets this run planned but skipped; a signal whose `gate`
            is one of them is reported NOT RUN.
    Returns:
        tuple[list[dict[str, object]], list[str]]: Per-file metrics and explicit accounting failures.
    Raises:
        ValueError: The OS is unmeasured, a skipped gate is declared by no policy signal, or a package
            inventory cannot be expanded.
    """
    if runner_os not in {"darwin", "linux"}:
        raise ValueError(f"Coverage is not measured on OS: '{runner_os}'")
    require_declared_gates(policy, skipped_gates)
    results: list[dict[str, object]] = []
    errors: list[str] = []
    for name, package in policy.packages.items():
        owned = inventory(root, package)
        if package.status == "pending":
            LOGGER.warning(f"NOT MEASURED, TRACKED: '{name}': {package.note}")
            if policy.enforce_target and package.goal == "100-percent":
                errors.append(f"Unmeasured package: '{name}'")
            continue
        for signal_name, signal in package.signals.items():
            label = f"{name}/{signal_name}"
            reason = not_run_reason(signal, host, skipped_gates)
            if reason:
                LOGGER.warning(f"NOT RUN: '{label}': {reason}")
                continue
            try:
                validate_signal_inventory(owned, signal_name, signal)
                if not measure and runner_os not in signal.max_uncovered:
                    raise ValueError(f"Missing OS floor: '{runner_os}'")
                records = scoped_records(root, policy, package, signal, reports_root)
                uncovered_lines = sum(c.uncovered_lines for c in records.values())
                uncovered_functions = sum(c.uncovered_functions for c in records.values())
                uncovered_branches = sum(c.uncovered_branches for c in records.values())
                for path, counters in sorted(records.items()):
                    item = {"package": name, "signal": signal_name, "os": runner_os, "file": path} | vars(
                        counters
                    )
                    results.append(item)
                    LOGGER.info(f"{label} {path}: {counters}")
                LOGGER.info(
                    f"{label}/{runner_os} ({signal.enforcement}): "
                    f"uncovered lines={uncovered_lines}, functions={uncovered_functions}, "
                    f"branches={uncovered_branches}"
                )
                reference = signal.max_uncovered.get(runner_os)
                if reference is not None:
                    capped = reference.branches is not None
                    LOGGER.info(
                        f"{label}/{runner_os}: reference lines={reference.lines}, "
                        f"functions={reference.functions}"
                        + (f", branches={reference.branches}" if capped else "")
                        + f"; delta lines={uncovered_lines - reference.lines:+d}, "
                        f"functions={uncovered_functions - reference.functions:+d}"
                        + (
                            f", branches={uncovered_branches - (reference.branches or 0):+d}"
                            if capped
                            else ""
                        )
                    )
                if measure:
                    continue
                declared = signal.max_uncovered[runner_os]
                check_branch_cap(package, declared, records)
                # Until `target.branches` locks it, a 100-percent primary keeps its own branch cap.
                budget = (
                    policy.target.model_copy(
                        update={"branches": declared.branches} if policy.target.branches is None else {}
                    )
                    if policy.enforce_target and package.goal == "100-percent" and signal_name == "primary"
                    else declared
                )
                if signal.enforcement == "enforced" and (
                    uncovered_lines > budget.lines
                    or uncovered_functions > budget.functions
                    or (budget.branches is not None and uncovered_branches > budget.branches)
                ):
                    measured = describe(
                        uncovered_lines,
                        uncovered_functions,
                        uncovered_branches if budget.branches is not None else None,
                    )
                    allowed = describe(budget.lines, budget.functions, budget.branches)
                    raise ValueError(f"Budget exceeded: {measured} uncovered, budget {allowed}")
            except (OSError, ValueError) as error:
                errors.append(f"{label}: {error}")
    return results, errors


def signal_comparisons(
    policy: Policy, totals: dict[str, dict[str, int]], runner_os: str
) -> dict[str, dict[str, object]]:
    """Expose each signal's enforcement and signed deltas from its stored reference.

    Parameters:
        policy (Policy): Validated current reference and enforcement declarations.
        totals (dict[str, dict[str, int]]): Measured aggregate counters by package/signal.
        runner_os (str): OS associated with the measured reports.
    Returns:
        dict[str, dict[str, object]]: Enforcement, reason, reference and signed uncovered deltas.
    Raises:
        KeyError: Aggregate labels do not belong to the validated policy.
    """
    comparisons: dict[str, dict[str, object]] = {}
    for label, counts in totals.items():
        name, signal_name = label.split("/")
        signal = policy.packages[name].signals[signal_name]
        reference = signal.max_uncovered.get(runner_os)
        comparisons[label] = {
            "enforcement": signal.enforcement,
            "reason": signal.reason,
            "reference": reference.model_dump(exclude_none=True) if reference is not None else None,
            "delta": {
                "lines": counts["uncovered_lines"] - reference.lines,
                "functions": counts["uncovered_functions"] - reference.functions,
            }
            | (
                {"branches": counts["uncovered_branches"] - reference.branches}
                if reference.branches is not None
                else {}
            )
            if reference is not None
            else None,
        }
    return comparisons


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
                policy.model_dump_json(indent=2, exclude_none=True).splitlines(keepends=True),
                proposed.model_dump_json(indent=2, exclude_none=True).splitlines(keepends=True),
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
    bases = parser.add_mutually_exclusive_group()
    bases.add_argument("--base", help="Explicit Git base for gating, used unchanged; not used by --measure.")
    bases.add_argument("--compare-ref", help="Gate against the merge base of HEAD and this ref instead.")
    parser.add_argument("--os", default=sys.platform, choices=["darwin", "linux"])
    parser.add_argument("--host", help="CI host class (e.g. wsl2) selecting signals' `skip_hosts`.")
    parser.add_argument(
        "--skipped-gates",
        default="",
        help="Space-separated Make targets the CI plan skipped; signals produced by them report NOT RUN.",
    )
    parser.add_argument("--reports-root", type=Path, help="Root of downloaded CI artifacts.")
    parser.add_argument("--measure", action="store_true", help="Print measured policy diff; NOT a gate.")
    parser.add_argument("--summary", type=Path, default=Path("coverage/summary.json"))
    args = parser.parse_args()
    if not args.measure and not args.base and args.compare_ref is None:
        parser.error("--base or --compare-ref is required unless --measure is selected")
    if args.measure and (args.base or args.compare_ref is not None):
        parser.error("--measure cannot enforce --base or --compare-ref; use a separate gating invocation")
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
    policy: Policy | None = None
    try:
        if args.compare_ref is not None:
            args.base = divergence_base(root, args.compare_ref)
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
            base = base_policy(previous)
            check_ratchet(policy, base)
            check_inventory_ratchet(root, policy, base, args.base)
        results, errors = account(
            root,
            policy,
            args.os,
            args.reports_root,
            args.measure,
            host=args.host,
            skipped_gates=frozenset(args.skipped_gates.split()),
        )
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
    # A producer without branch records proposes no branch cap; `check_branch_cap` would reject one.
    floors = {
        label: {
            args.os: {"lines": counts["uncovered_lines"], "functions": counts["uncovered_functions"]}
            | ({"branches": counts["uncovered_branches"]} if counts["branches"] else {})
        }
        for label, counts in totals.items()
    }
    if args.measure and not errors and policy is not None:
        log_measured_diff(policy, floors, args.os)
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(
        json.dumps(
            {
                "os": args.os,
                "measurement_only": args.measure,
                "measured_floors": floors,
                "packages": totals,
                "signals": signal_comparisons(policy, totals, args.os) if policy is not None else {},
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
