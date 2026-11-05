"""Shared miniature policies, LCOV reports and disposable Git bases for the coverage tests.

References:
    ../../docs/coverage.md
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coverage_accounting import Policy, git_read

FIXTURES = Path(__file__).parent / "fixtures" / "coverage"
SCRIPT = Path(__file__).resolve().parents[1] / "coverage_accounting.py"
ROOT = Path(__file__).resolve().parents[2]
JS_SUFFIXES = {".mjs", ".cjs", ".js"}


def policy() -> Policy:
    """Return a measured miniature policy.

    Parameters:
        None.
    Returns:
        Policy: Validated fixture ownership and budgets.
    Raises:
        ValidationError: The fixture policy is invalid.
    """
    return Policy.model_validate(
        {
            "version": 2,
            "target": {"lines": 0, "functions": 0},
            "enforce_target": False,
            "packages": {
                "example": {
                    "root": "packages/example",
                    "owned": ["src/*.ts"],
                    "exclusions": [],
                    "status": "measured",
                    "note": "",
                    "signals": {
                        "primary": {
                            "report": "coverage/lcov.info",
                            "files": ["src/index.ts"],
                            "max_uncovered": {
                                "darwin": {"lines": 0, "functions": 0},
                                "linux": {"lines": 0, "functions": 0},
                            },
                            "reporters": ["text", "lcov"],
                        }
                    },
                }
            },
        }
    )


def setup_report(tmp_path: Path, fixture: str = "passing.info") -> Path:
    """Create disposable source paths and a real LCOV fixture.

    Parameters:
        tmp_path (Path): Disposable source root.
        fixture (str): Stored LCOV fixture filename.
    Returns:
        Path: Created LCOV report path.
    Raises:
        OSError: Fixture files cannot be created or read.
    """
    (tmp_path / "package.json").write_text(json.dumps({"workspaces": ["packages/*"]}))
    directory = tmp_path / "packages/example"
    (directory / "src").mkdir(parents=True)
    (directory / "package.json").write_text("{}\n")
    (directory / "src/index.ts").write_text("export function answer() { return 42; }\n")
    (directory / "coverage").mkdir()
    report = directory / "coverage/lcov.info"
    shutil.copyfile(FIXTURES / fixture, report)
    return report


def branch_policy(cap: int | None, **package: object) -> Policy:
    """Return the miniature policy with a branch cap on the active OS.

    Parameters:
        cap (int | None): Uncovered-branch cap, or None for no `branches` key.
        **package (object): Package fields to override, e.g. `goal`.
    Returns:
        Policy: Validated fixture policy.
    Raises:
        ValidationError: The overridden fixture policy is invalid.
    """
    data = policy().model_dump(exclude_none=True)
    data["packages"]["example"] |= package
    data["packages"]["example"]["signals"]["primary"]["max_uncovered"][sys.platform]["branches"] = cap
    if package.get("goal") not in {None, "100-percent"}:
        data["packages"]["example"]["signals"]["primary"] |= {
            "enforcement": "report-only",
            "reason": "Fixture.",
        }
    return Policy.model_validate(data)


def commit_base(root: Path, cfg: Policy) -> None:
    """Persist a miniature policy and its source in a real immutable Git commit.

    Parameters:
        root (Path): Disposable repository directory.
        cfg (Policy): Base ownership and coverage declarations.
    Returns:
        None: HEAD contains the base policy and original source.
    Raises:
        subprocess.CalledProcessError: A fixture Git operation fails.
    """
    (root / "coverage").mkdir(exist_ok=True)
    (root / "coverage/policy.json").write_text(cfg.model_dump_json())
    for args in [
        ["init", "-q", "--template="],
        ["add", "."],
        [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-qm",
            "Base",
        ],
    ]:
        git_read(root, args)


def scope_fixture(root: Path) -> Policy:
    """Create a two-file source inventory whose base survives working-tree mutation.

    Parameters:
        root (Path): Disposable repository directory.
    Returns:
        Policy: Policy committed alongside both original source files.
    Raises:
        OSError: Fixture files cannot be written.
        subprocess.CalledProcessError: Git cannot commit the base.
    """
    setup_report(root)
    (root / "packages/example/src/kept.ts").write_text("export const kept = 1;\n")
    cfg = policy()
    cfg.packages["example"].signals["primary"].files = None
    commit_base(root, cfg)
    return cfg
