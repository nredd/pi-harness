"""Command-line interface for the operator-driven benchmark.

References:
- https://docs.python.org/3/library/argparse.html
"""

from __future__ import annotations

import argparse
import logging
from pathlib import Path
from typing import TYPE_CHECKING, NoReturn

from pydantic import ValidationError

from pi_harness_benchmark.finalize import finalize_run, mark_run
from pi_harness_benchmark.fixtures import generate_fixtures
from pi_harness_benchmark.matrix import generate_matrix
from pi_harness_benchmark.prepare import prepare_run, write_matrix
from pi_harness_benchmark.report import write_report

if TYPE_CHECKING:
    from pi_harness_benchmark.models import RunSpec

LOGGER = logging.getLogger(__name__)


def _path(value: str) -> Path:
    """Resolve a command-line path.

    Parameters:
        value (str): User-supplied path.

    Returns:
        Path: Absolute normalized path.
    """
    return Path(value).expanduser().resolve()


def _parser() -> argparse.ArgumentParser:
    """Build the complete argument parser.

    Returns:
        argparse.ArgumentParser: Configured parser.
    """
    parser = argparse.ArgumentParser(
        prog="pi-harness-benchmark",
        description="Prepare and analyze operator-driven native coding-agent runs.",
    )
    parser.add_argument(
        "--root",
        type=_path,
        default=Path.cwd(),
        help="benchmark project root (default: current directory)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate = subparsers.add_parser("generate", help="generate deterministic seed repositories")
    generate.add_argument("--force", action="store_true", help="replace generated fixtures")

    matrix = subparsers.add_parser("matrix", help="write the fixed 36-run matrix")
    matrix.add_argument("--output", type=_path, help="matrix JSON destination")

    prepare = subparsers.add_parser("prepare", help="prepare one pristine run clone")
    prepare.add_argument("run_id", help="run ID from the generated matrix")
    prepare.add_argument("--replace", action="store_true", help="replace an existing prepared run")

    mark = subparsers.add_parser("mark", help="record an operator timing boundary")
    mark.add_argument("run_dir", type=_path, help="prepared run directory")
    mark.add_argument("event", choices=("start", "implementation", "stop"))
    mark.add_argument(
        "--allow-out-of-order",
        action="store_true",
        help="development/test override for isolated runs",
    )

    finalize = subparsers.add_parser("finalize", help="finalize one stopped run without repairs")
    finalize.add_argument("run_dir", type=_path, help="stopped run directory")

    report = subparsers.add_parser("report", help="write within-provider pairwise summaries")
    report.add_argument("--results-root", type=_path, help="tree containing result JSON files")
    report.add_argument("--output", type=_path, help="report JSON destination")
    return parser


def _find_run(run_id: str) -> RunSpec:
    """Find one run specification by stable ID.

    Parameters:
        run_id (str): Matrix run ID.

    Returns:
        RunSpec: Matching matrix row.

    Raises:
        ValueError: If the run ID is unknown.
    """
    match = next((run for run in generate_matrix() if run.run_id == run_id), None)
    if match is None:
        msg = f"Unknown matrix run ID: '{run_id}'"
        raise ValueError(msg)
    return match


def _fail(message: str) -> NoReturn:
    """Log a fatal operator error and exit.

    Parameters:
        message (str): Actionable error text.

    Raises:
        SystemExit: Always, with status 2.
    """
    LOGGER.error(message)
    raise SystemExit(2)


def main() -> None:
    """Execute one benchmark CLI command."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args = _parser().parse_args()
    root = Path(str(args.root)).resolve()
    try:
        if args.command == "generate":
            commits = generate_fixtures(root / "workspace", force=args.force)
            for fixture, commit in commits.items():
                LOGGER.info(f"{fixture.value}: {commit}")
            return
        if args.command == "matrix":
            destination = args.output or root / "workspace" / "matrix.json"
            runs = generate_matrix()
            write_matrix(destination, runs)
            LOGGER.info(f"Wrote {len(runs)} runs to '{destination}'")
            return
        if args.command == "prepare":
            spec = _find_run(args.run_id)
            manifest, instructions = prepare_run(root, spec, replace=args.replace)
            LOGGER.info(instructions.rstrip())
            LOGGER.info(f"Prepared manifest: '{manifest.run_dir / 'manifest.json'}'")
            return
        if args.command == "mark":
            manifest = mark_run(
                args.run_dir,
                args.event,
                allow_out_of_order=args.allow_out_of_order,
            )
            LOGGER.info(f"Recorded '{args.event}' for '{manifest.spec.run_id}'")
            return
        if args.command == "finalize":
            result = finalize_run(args.run_dir)
            LOGGER.info(f"Result: '{result.result_path}'")
            LOGGER.info(
                f"Visible={result.visible_gate.passed} hidden={result.hidden_gate.passed} "
                f"success={result.success}"
            )
            return
        results_root = args.results_root or root / "artifacts" / "runs"
        destination = args.output or root / "artifacts" / "report.json"
        report = write_report(results_root, destination)
        LOGGER.info(
            f"Wrote {report['result_count']} results to '{destination}' and "
            f"'{destination.with_suffix('.md')}'"
        )
    except (FileNotFoundError, FileExistsError, RuntimeError, ValueError, ValidationError) as exc:
        _fail(str(exc))
