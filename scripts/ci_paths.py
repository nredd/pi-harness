"""Plan every CI cell from a Git diff: what runs, which gates, and why a cell reports NOT RUN.

`classify` reads the diff, `plan_cells` turns the classification into one decision per required check
name, and `write_github_output` publishes both. The workflow only consumes the plan with step-level `if`
conditions, so every run/skip rule is testable here over real diffs.

To add an input class (a set of paths that wakes some cell), add one `is_*_input` predicate, one
`INPUT_CLASSES` entry, and the rule in `plan_cells` that reads `ChangeClassification.inputs`.

References:
    https://git-scm.com/docs/git-diff
    https://git-scm.com/docs/git-rev-parse
    https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/passing-information-between-jobs
    https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/evaluate-expressions-in-workflows-and-actions
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import subprocess
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

LOGGER = logging.getLogger(__name__)

GIT = "/usr/bin/git"
REPO_ROOT = Path(__file__).resolve().parents[1]
TESTED_DOCUMENTATION = frozenset({"README.md", "packages/preset/README.md"})
# Tool pins and root manifests read by both the WSL bootstrap and the stack job.
TOOLCHAIN_INPUTS = frozenset(
    {"Makefile", "package.json", ".gitmodules", ".node-version", ".bun-version", ".python-version"}
)
WSL_INPUT_FILES = TOOLCHAIN_INPUTS | {
    ".gitattributes",
    "package-lock.json",
    "integration/pyproject.toml",
    "integration/uv.lock",
    "scripts/check-biome-paths.mjs",
    "scripts/check-biome-paths.test.mjs",
    "scripts/import_audit.test.ts",
    "scripts/import_audit.ts",
    "scripts/install_gh_linux.sh",
    "scripts/install_wsl_owned_tools.sh",
    "scripts/router_contract.mjs",
    "scripts/run-vitest.ts",
    "scripts/vitest.config.ts",
}
WSL_INPUT_PREFIXES = (".github/", "integration/probes/", "scripts/wsl2_", "scripts/ci")
STACK_INPUT_FILES = TOOLCHAIN_INPUTS | {
    "package-lock.json",
    "integration/conftest.py",
    "integration/pyproject.toml",
    "integration/uv.lock",
}
# `packages/` is absent on purpose: `harness.stack` maps those paths into `local` only.
STACK_INPUT_PREFIXES = (
    ".github/",
    "forks/",
    "integration/golden/",
    "integration/harness/",
    "integration/probes/",
    "integration/providers/",
    "integration/scenarios/",
    "integration/stacks/",
    "scripts/wsl2_",
)
EVENT_PULL_REQUEST = "pull_request"
EVENT_PUSH = "push"
# GitHub squashes a PR to `<title> (#N)`; `main` lints that subject (`check-commit-messages.mjs`).
SQUASH_SUBJECT_LIMIT = 72
CHECK_TS = "check-ts"


@dataclass(frozen=True)
class Shard:
    """One parallel job of an `owned` cell; the cell's required check is a fan-in over its shards.

    Parameters:
        name (str): Job suffix, `owned shard (<os>, <name>)`.
        gates (tuple[str, ...]): Make targets the shard runs, one workflow step each.
        workspaces (tuple[str, ...]): npm workspaces its `check-ts` runs. Empty means every workspace no other
            shard of the same cell names, so a new workspace lands in a shard without editing this table.
    """

    name: str
    gates: tuple[str, ...]
    workspaces: tuple[str, ...] = ()


# Shard units and timings are in #350 and docs/ci.md. Native cells run every Python gate; WSL keeps only the
# LCOV producers (Ubuntu runs the Python unit suites). macOS stays at two shards: a public repo gets 5
# concurrent macOS runners, shared by every PR. WSL stays at two: each Windows job pays ~3.5 min of guest
# setup, and two shards already finish inside the macOS critical path. `check-benchmark` marks the shard that
# carries the macOS benchmark steps.
OWNED_SHARDS: dict[str, tuple[Shard, ...]] = {
    "ubuntu-24.04": (
        Shard("subagents", (CHECK_TS,), ("packages/subagents",)),
        Shard("computer-use", (CHECK_TS,), ("packages/computer-use",)),
        Shard("ts", (CHECK_TS,)),
        Shard("python", ("check-scripts", "check-integration")),
    ),
    "macos-14": (
        Shard("ts", (CHECK_TS,)),
        Shard("python", ("check-scripts", "check-integration", "check-benchmark")),
    ),
    "wsl2": (
        Shard("subagents-computer-use", (CHECK_TS,), ("packages/computer-use", "packages/subagents")),
        Shard("ts", (CHECK_TS, "check-probes", "check-import-audit")),
    ),
}
OWNED_GATES = {
    os_name: tuple(dict.fromkeys(gate for shard in shards for gate in shard.gates))
    for os_name, shards in OWNED_SHARDS.items()
}
# Runner label and execution guest per OS, as the `contracts` matrix spells them (a test pins the two).
RUNNERS = {
    "ubuntu-24.04": ("ubuntu-24.04", "linux"),
    "macos-14": ("xcode-27", "macos"),
    "wsl2": ("windows-2025", "wsl2"),
}
# The platform whose coverage floors account a cell's reports (`coverage_accounting.py --os`); the fan-in
# runs on Ubuntu, so it cannot read its own `sys.platform`. WSL reports are Linux reports.
COVERAGE_OS = {"ubuntu-24.04": "linux", "macos-14": "darwin", "wsl2": "linux"}
STACKS = ("personal", "local")
SMOKE_CELL = ("ubuntu-24.04", "personal")
# NOT RUN reasons; the reporter appends "This is not a pass." to each.
NOT_RUN = {
    "docs_only": "Skipped because the change is docs-only.",
    "main_smoke": "Skipped on a main push; stack (ubuntu-24.04, personal) validates the merged result.",
    "personal_without_inputs": (
        "This pull request changes no stack inputs; the personal stack installs published packages, "
        "so its scenarios cannot change. Setup still runs."
    ),
}
WSL_BYPASS = (
    "This pull request changes no CI or WSL inputs; {job} (wsl2) runs for real on main pushes "
    "and on PRs that change them."
)
_WSL_STACK = "WSL runs no stack cell; owned (wsl2) and contracts (wsl2) are its only evidence."
STACK_NOT_RUN = {
    (
        "macos-14",
        "personal",
    ): "macOS runs only the local stack; ubuntu-24.04 carries the published personal stack.",
    ("wsl2", "personal"): _WSL_STACK,
    ("wsl2", "local"): _WSL_STACK,
}
# JavaScript's `\s` (ECMAScript WhiteSpace + LineTerminator), not Python's: Python adds \x1c-\x1f and \x85 and
# omits U+FEFF. `check-commit-messages.mjs` `validSubject`: optional `area: ` prefix, a capital, no trailing
# period.
JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
SUBJECT_PATTERN = re.compile(rf"(?:[a-z][a-z0-9-]*: )?[A-Z][^\n]*[^.{JS_WHITESPACE}]")
# What `check-benchmark` and its macOS step read: the Makefile recipes, `UV_PYTHON` from `.python-version`,
# the Node that installs the pinned Codex, the workflow and tool setup that pin and run them, and this
# classifier, so a broken predicate cannot switch the gate off on the PR that breaks it.
BENCHMARK_INPUT_FILES = frozenset(
    {"Makefile", ".python-version", ".node-version", ".github/workflows/ci.yml", "scripts/ci_paths.py"}
)
BENCHMARK_INPUT_PREFIXES = ("benchmarks/comparison/", ".github/actions/setup-ci-tools/")
FULL_RELEASE_CANDIDATE = "Full frozen release candidate"


class ClassificationError(RuntimeError):
    """A repository precondition or Git comparison failed."""


@dataclass(frozen=True)
class ChangeClassification:
    """The paths changed by a comparison and their CI classification.

    Parameters:
        paths (tuple[str, ...]): Changed paths relative to the repository root.
        docs_only (bool): Whether every changed path is safe documentation.
        inputs (Mapping[str, bool]): Per `INPUT_CLASSES` name, whether a change reaches that work.
    """

    paths: tuple[str, ...]
    docs_only: bool
    inputs: Mapping[str, bool]


@dataclass(frozen=True)
class ShardPlan:
    """One shard job of a running `owned` cell, as its matrix entry.

    Parameters:
        os (str): Matrix `os` value of the cell.
        name (str): Shard name.
        runner (str): Runner label.
        guest (str): Execution guest, `linux`, `macos` or `wsl2`.
        gates (tuple[str, ...]): Make targets, one workflow step each.
        workspaces (tuple[str, ...]): npm workspaces its `check-ts` runs, in npm workspace order.
    """

    os: str
    name: str
    runner: str
    guest: str
    gates: tuple[str, ...]
    workspaces: tuple[str, ...]

    def to_output(self) -> dict[str, str]:
        """Return the matrix `include` entry the shard job reads.

        Returns:
            dict[str, str]: Strings only; gates and workspaces are space-joined.
        """
        return {
            "os": self.os,
            "shard": self.name,
            "runner": self.runner,
            "guest": self.guest,
            "gates": " ".join(self.gates),
            "workspaces": " ".join(self.workspaces),
        }


@dataclass(frozen=True)
class CellPlan:
    """What one required check name does on this run.

    Parameters:
        run (bool): Whether the cell does real work. False reports NOT RUN from a cheap bypass runner.
        scenarios (bool): Whether the cell's scenario steps run (the personal stack can run setup only).
        gates (tuple[str, ...]): Make targets an `owned` cell runs across its shards.
        reason (str): Why work is skipped, empty when everything the cell owns runs.
        blocked (bool): Whether the cell must fail with `reason` (an invalid PR title).
        shards (tuple[ShardPlan, ...]): The shard jobs a running `owned` cell fans in, else empty.
        guest (str): A running `owned` cell's CI host class (`coverage_accounting.py --host`), else empty.
        coverage_os (str): A running `owned` cell's coverage platform (`coverage_accounting.py --os`), else
            empty.
    """

    run: bool
    scenarios: bool
    gates: tuple[str, ...]
    reason: str
    blocked: bool = False
    shards: tuple[ShardPlan, ...] = ()
    guest: str = ""
    coverage_os: str = ""

    def to_output(self) -> dict[str, object]:
        """Return the JSON-ready form the workflow reads with `fromJSON`.

        Returns:
            dict[str, object]: Booleans, the space-joined gates, the reason, the block flag, the shard
                matrix entries and the fan-in's accounting `guest` and `coverage_os`.
        """
        return {
            "run": self.run,
            "scenarios": self.scenarios,
            "gates": " ".join(self.gates),
            "reason": self.reason,
            "blocked": self.blocked,
            "shards": [shard.to_output() for shard in self.shards],
            "guest": self.guest,
            "coverage_os": self.coverage_os,
        }


def run_git(repo: Path, *args: str) -> str:
    """Run Git in a repository and return standard output.

    Parameters:
        repo (Path): Existing repository directory.
        *args (str): Arguments after `git -C <repo>`.

    Returns:
        str: Captured Git standard output.

    Raises:
        ClassificationError: Git cannot start or exits unsuccessfully.
    """
    try:
        completed = subprocess.run([GIT, "-C", str(repo), *args], check=False, capture_output=True, text=True)
    except OSError as e:
        raise ClassificationError(f"Cannot run `git` in '{repo}': {e}") from e
    if completed.returncode != 0:
        raise ClassificationError(f"`git {' '.join(args)}` failed in '{repo}': {completed.stderr.strip()}")
    return completed.stdout


def repo_root(start: Path) -> Path:
    """Return the resolved top-level directory containing a repository path.

    Parameters:
        start (Path): Existing directory inside the repository.

    Returns:
        Path: Resolved repository top-level directory.

    Raises:
        ClassificationError: `start` is missing, not a directory, or outside a Git work tree.
    """
    if not start.is_dir():
        raise ClassificationError(f"Not a directory: '{start}'")
    return Path(run_git(start, "rev-parse", "--show-toplevel").strip()).resolve()


def changed_paths(repo: Path, base: str, head: str) -> tuple[str, ...]:
    """Return all tracked paths changed between two Git revisions.

    Parameters:
        repo (Path): Existing Git working tree.
        base (str): Earlier Git revision.
        head (str): Later Git revision.

    Returns:
        tuple[str, ...]: Sorted, duplicate-free paths relative to `repo`.

    Raises:
        ClassificationError: The repository or revisions cannot be compared, or a Gitlink changed.
    """
    root = repo_root(repo)
    output = run_git(root, "diff", "--raw", "--no-renames", "-z", "--diff-filter=ACDMRTUXB", base, head)
    fields = output.split("\0")
    if fields[-1]:
        raise ClassificationError("`git diff --raw -z` returned an unterminated record")
    entries = fields[:-1]
    if len(entries) % 2:
        raise ClassificationError("`git diff --raw -z` returned an incomplete record")

    paths: set[str] = set()
    for metadata, path in zip(entries[::2], entries[1::2], strict=True):
        parts = metadata.split()
        if len(parts) != 5 or not parts[0].startswith(":"):
            raise ClassificationError(f"`git diff --raw -z` returned malformed metadata: '{metadata}'")
        old_mode, new_mode = parts[0][1:], parts[1]
        if old_mode == "160000" or new_mode == "160000":
            raise ClassificationError(f"Gitlink changed at '{path}'")
        paths.add(path)
    return tuple(sorted(paths))


def is_documentation_path(path: str) -> bool:
    """Return whether one changed path is safe to bypass expensive CI.

    Parameters:
        path (str): Git-relative path with POSIX separators.

    Returns:
        bool: Whether the path is documentation that no repository test reads as input.
    """
    if path in TESTED_DOCUMENTATION:
        return False
    if path == "PLAN.md" or (path.startswith("docs/") and path.endswith(".md")):
        return True
    if "/" not in path and path.endswith(".md"):
        return True
    parts = path.split("/")
    return len(parts) == 3 and parts[0] == "packages" and parts[2] in {"README.md", "CHANGELOG.md"}


def is_wsl_input(path: str) -> bool:
    """Return whether one changed path reaches the WSL setup, adapter or guest gates.

    Parameters:
        path (str): Git-relative path with POSIX separators.

    Returns:
        bool: Whether a PR changing the path must run the WSL cells for real.
    """
    return path in WSL_INPUT_FILES or path.startswith(WSL_INPUT_PREFIXES)


def is_stack_input(path: str) -> bool:
    """Return whether one changed path reaches the personal stack scenarios.

    Parameters:
        path (str): Git-relative path with POSIX separators.

    Returns:
        bool: Whether a PR changing the path must run the personal stack steps.
    """
    return path in STACK_INPUT_FILES or path.startswith(STACK_INPUT_PREFIXES)


def is_benchmark_input(path: str) -> bool:
    """Return whether one changed path reaches the `benchmarks/comparison` unit gate.

    Parameters:
        path (str): Git-relative path with POSIX separators.

    Returns:
        bool: Whether a PR changing the path must run `check-benchmark` for real.
    """
    return path in BENCHMARK_INPUT_FILES or path.startswith(BENCHMARK_INPUT_PREFIXES)


# One entry per class of paths that wakes optional work; `ChangeClassification.inputs` and the published
# outputs follow this mapping.
INPUT_CLASSES: dict[str, Callable[[str], bool]] = {
    "wsl_inputs": is_wsl_input,
    "stack_inputs": is_stack_input,
    "benchmark_inputs": is_benchmark_input,
}


def full_classification() -> ChangeClassification:
    """Return the classification of a run that has no diff to read: everything is an input.

    Returns:
        ChangeClassification: Not docs-only, every input true, a single label for the changed files.
    """
    return ChangeClassification(
        paths=(FULL_RELEASE_CANDIDATE,), docs_only=False, inputs=dict.fromkeys(INPUT_CLASSES, True)
    )


def classify(repo: Path, base: str, head: str) -> ChangeClassification:
    """Classify a real Git diff conservatively, failing closed on errors.

    Parameters:
        repo (Path): Existing Git working tree.
        base (str): Earlier Git revision.
        head (str): Later Git revision.

    Returns:
        ChangeClassification: Changed paths, whether all are safe documentation paths, and which
            conditional work they reach. An unreadable or empty comparison reaches everything.
    """
    try:
        paths = changed_paths(repo, base, head)
    except ClassificationError as e:
        LOGGER.error(f"Failed to classify changed paths: {e}")
        return ChangeClassification(paths=(), docs_only=False, inputs=dict.fromkeys(INPUT_CLASSES, True))
    return ChangeClassification(
        paths=paths,
        docs_only=bool(paths) and all(map(is_documentation_path, paths)),
        inputs={name: not paths or any(map(predicate, paths)) for name, predicate in INPUT_CLASSES.items()},
    )


def utf16_length(text: str) -> int:
    """Return the length JavaScript's `String.length` reports, in UTF-16 code units.

    Parameters:
        text (str): Any text.

    Returns:
        int: UTF-16 code units, so an astral character such as an emoji counts twice.
    """
    return len(text.encode("utf-16-le")) // 2


def is_valid_subject(subject: str) -> bool:
    """Mirror `validSubject` in `packages/computer-use/scripts/check-commit-messages.mjs`.

    Parameters:
        subject (str): Commit subject.

    Returns:
        bool: At most 72 UTF-16 units, a capital first letter after an optional `area: ` prefix, and no
            trailing period or whitespace. A test runs the real lint over the same cases.
    """
    return utf16_length(subject) <= SQUASH_SUBJECT_LIMIT and SUBJECT_PATTERN.fullmatch(subject) is not None


def squash_subject_problem(title: str, number: int) -> str:
    """Return why a PR title would fail the squash-subject lint on `main`, or an empty string.

    Parameters:
        title (str): Pull request title.
        number (int): Pull request number GitHub appends as ` (#N)`.

    Returns:
        str: A fix-it message when `<title> (#N)` fails the lint, else an empty string.
    """
    subject = f"{title} (#{number})"
    if is_valid_subject(subject):
        return ""
    length = utf16_length(subject)
    room = SQUASH_SUBJECT_LIMIT - utf16_length(f" (#{number})")
    return (
        f"The squash subject '{subject}' fails the commit lint on main: it must be at most "
        f"{SQUASH_SUBJECT_LIMIT} UTF-16 units (this one is {length}; keep the title to {room}), start with a "
        "capital letter after an optional `area: ` prefix, and not end in a period."
    )


def skipped(reason: str) -> CellPlan:
    """Return the plan for a cell that only reports NOT RUN.

    Parameters:
        reason (str): Why nothing runs.

    Returns:
        CellPlan: A bypass cell.
    """
    return CellPlan(run=False, scenarios=False, gates=(), reason=reason)


def npm_workspaces(root: Path) -> tuple[str, ...]:
    """Return the npm workspaces in the order `npm run <script> --workspaces` visits them.

    Parameters:
        root (Path): Repository root holding the root `package.json`.

    Returns:
        tuple[str, ...]: Workspace paths relative to `root`, pattern by pattern, sorted within each pattern.

    Raises:
        ClassificationError: The manifest is missing or malformed, or no workspace directory exists.
    """
    manifest = root / "package.json"
    try:
        patterns = json.loads(manifest.read_text(encoding="utf-8")).get("workspaces", [])
    except (OSError, json.JSONDecodeError) as e:
        raise ClassificationError(f"Cannot read npm workspaces from '{manifest}': {e}") from e
    found = tuple(
        path.relative_to(root).as_posix()
        for pattern in patterns
        for path in sorted(root.glob(pattern))
        if (path / "package.json").is_file()
    )
    if not found:
        raise ClassificationError(f"'{manifest}' declares no workspaces")
    return found


def shard_plans(os_name: str, workspaces: tuple[str, ...]) -> tuple[ShardPlan, ...]:
    """Expand an `owned` cell's `OWNED_SHARDS` entry into its shard jobs.

    Parameters:
        os_name (str): Matrix `os` value.
        workspaces (tuple[str, ...]): Every npm workspace, in npm order.

    Returns:
        tuple[ShardPlan, ...]: One entry per shard; a `check-ts` shard naming no workspaces takes the rest.

    Raises:
        ClassificationError: A shard names a workspace that does not exist, or a `check-ts` shard has none to
            run (`make check-ts WORKSPACES=` with an empty list would run them all).
    """
    shards = OWNED_SHARDS[os_name]
    named = {workspace for shard in shards for workspace in shard.workspaces}
    unknown = named.difference(workspaces)
    if unknown:
        raise ClassificationError(f"owned ({os_name}) names unknown workspaces: {sorted(unknown)}")
    runner, guest = RUNNERS[os_name]
    plans = []
    for shard in shards:
        chosen = set(shard.workspaces) if shard.workspaces else set(workspaces) - named
        selected = tuple(workspace for workspace in workspaces if workspace in chosen)
        if CHECK_TS in shard.gates and not selected:
            raise ClassificationError(
                f"owned shard ({os_name}, {shard.name}) runs check-ts with no workspaces"
            )
        plans.append(
            ShardPlan(
                os_name, shard.name, runner, guest, shard.gates, selected if CHECK_TS in shard.gates else ()
            )
        )
    return tuple(plans)


def native_plan(
    job: str, os_name: str, result: ChangeClassification, event: str, workspaces: tuple[str, ...]
) -> CellPlan:
    """Plan an `owned` or `contracts` cell.

    Parameters:
        job (str): Workflow job name, `owned` or `contracts`.
        os_name (str): Matrix `os` value.
        result (ChangeClassification): Diff classification.
        event (str): Triggering event name.
        workspaces (tuple[str, ...]): Every npm workspace, for the `owned` shards.

    Returns:
        CellPlan: Whether the cell runs and, for `owned`, which gates on which shards.
    """
    if os_name == "wsl2" and event == EVENT_PULL_REQUEST and not result.inputs["wsl_inputs"]:
        return skipped(WSL_BYPASS.format(job=job))
    # A real WSL cell keeps its docs-only acceptance on `main`.
    if result.docs_only and os_name != "wsl2":
        return skipped(NOT_RUN["docs_only"])
    if job != "owned":
        return CellPlan(run=True, scenarios=True, gates=(), reason="")
    return CellPlan(
        run=True,
        scenarios=True,
        gates=OWNED_GATES[os_name],
        reason="",
        shards=shard_plans(os_name, workspaces),
        guest=RUNNERS[os_name][1],
        coverage_os=COVERAGE_OS[os_name],
    )


def stack_plan(os_name: str, stack: str, result: ChangeClassification, event: str) -> CellPlan:
    """Plan a `stack` cell.

    Parameters:
        os_name (str): Matrix `os` value.
        stack (str): Matrix `stack` value.
        result (ChangeClassification): Diff classification.
        event (str): Triggering event name.

    Returns:
        CellPlan: Whether the cell runs and whether its scenario steps run.
    """
    if (os_name, stack) in STACK_NOT_RUN:
        return skipped(STACK_NOT_RUN[os_name, stack])
    if result.docs_only:
        return skipped(NOT_RUN["docs_only"])
    if event == EVENT_PUSH and (os_name, stack) != SMOKE_CELL:
        return skipped(NOT_RUN["main_smoke"])
    if event == EVENT_PULL_REQUEST and stack == "personal" and not result.inputs["stack_inputs"]:
        return CellPlan(run=True, scenarios=False, gates=(), reason=NOT_RUN["personal_without_inputs"])
    return CellPlan(run=True, scenarios=True, gates=(), reason="")


def plan_cells(result: ChangeClassification, event: str, title_problem: str = "") -> dict[str, CellPlan]:
    """Plan every required check name, so each one keeps reporting.

    Parameters:
        result (ChangeClassification): Diff classification.
        event (str): Triggering event name.
        title_problem (str): A PR title failure; it blocks every cell before any slot does real work.

    Returns:
        dict[str, CellPlan]: One plan per ruleset context, keyed by the check name.

    Raises:
        ClassificationError: The checkout's npm workspaces cannot be read or split into shards.
    """
    # The checkout under test, which the shard jobs check out too, not the `--repo` the diff is read from.
    workspaces = npm_workspaces(REPO_ROOT)
    cells: dict[str, CellPlan] = {}
    for os_name in OWNED_SHARDS:
        cells[f"owned ({os_name})"] = native_plan("owned", os_name, result, event, workspaces)
        cells[f"contracts ({os_name})"] = native_plan("contracts", os_name, result, event, workspaces)
        for stack in STACKS:
            cells[f"stack ({os_name}, {stack})"] = stack_plan(os_name, stack, result, event)
    if title_problem:
        blocked = CellPlan(run=False, scenarios=False, gates=(), reason=title_problem, blocked=True)
        return dict.fromkeys(cells, blocked)
    return cells


def write_github_output(path: Path, result: ChangeClassification, cells: Mapping[str, CellPlan]) -> None:
    """Append the classification and the cell plan to a GitHub Actions output file.

    Parameters:
        path (Path): Existing GitHub Actions output file.
        result (ChangeClassification): Classification to publish.
        cells (Mapping[str, CellPlan]): Per check name plan to publish as one JSON line.

    Returns:
        None: The function appends workflow output.
    """
    delimiter = f"CI_PATHS_{uuid.uuid4().hex}"
    changed = "\n".join(result.paths)
    plan = {name: cell.to_output() for name, cell in cells.items()}
    with path.open("a", encoding="utf-8") as output:
        output.write(f"docs_only={str(result.docs_only).lower()}\n")
        for name, value in result.inputs.items():
            output.write(f"{name}={str(value).lower()}\n")
        output.write(f"plan={json.dumps(plan, sort_keys=True, separators=(',', ':'))}\n")
        output.write(f"changed_files<<{delimiter}\n{changed}\n{delimiter}\n")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse command-line arguments.

    Parameters:
        argv (list[str] | None): Arguments, or `sys.argv` when omitted.

    Returns:
        argparse.Namespace: Parsed arguments.
    """
    parser = argparse.ArgumentParser(description="Plan CI cells from changed paths")
    parser.add_argument("--repo", type=Path, default=REPO_ROOT)
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("--full", action="store_true", help="No diff to read: run every cell for real")
    parser.add_argument("--event", required=True, help="GitHub event name, e.g. pull_request or push")
    parser.add_argument("--pr-title", default="", help="Pull request title, checked as the squash subject")
    parser.add_argument("--pr-number", type=int, default=0, help="Pull request number")
    parser.add_argument("--github-output", type=Path, required=True)
    args = parser.parse_args(argv)
    if not args.full and not (args.base and args.head):
        parser.error("--base and --head are required unless --full is given")
    return args


def main(argv: list[str] | None = None) -> int:
    """Classify a diff, plan the cells and publish workflow outputs.

    Parameters:
        argv (list[str] | None): Arguments, or `sys.argv` when omitted.

    Returns:
        int: Process exit status.
    """
    args = parse_args(argv)
    problem = ""
    if args.event == EVENT_PULL_REQUEST:
        # Block the cells rather than exit non-zero: a missing title must not skip the one rule only this
        # module checks. (Any `classify` failure is separately turned red by every job.)
        problem = (
            squash_subject_problem(args.pr_title, args.pr_number)
            if args.pr_title and args.pr_number
            else "A pull_request plan needs --pr-title and --pr-number to check the squash subject."
        )
    result = full_classification() if args.full else classify(args.repo, args.base, args.head)
    try:
        cells = plan_cells(result, args.event, problem)
    except ClassificationError as e:
        # A failed `classify` turns every required check red; a plan without shards would skip real work.
        LOGGER.error(f"Failed to plan the CI cells: {e}")
        return 1
    write_github_output(args.github_output, result, cells)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
