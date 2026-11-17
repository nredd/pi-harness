"""Generate deterministic compact benchmark fixture repositories.

References:
- https://git-scm.com/docs/git-commit
- https://docs.astral.sh/uv/
- https://docs.astral.sh/ruff/
- https://docs.astral.sh/ty/
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from pi_harness_benchmark.models import Clarification, Fixture
from pi_harness_benchmark.process import executable, output

FIXTURE_PYPROJECT = """[build-system]
requires = [\"hatchling>=1.27\"]
build-backend = \"hatchling.build\"

[project]
name = \"{package_name}\"
version = \"0.1.0\"
description = \"{description}\"
readme = \"README.md\"
requires-python = \">=3.12\"

[dependency-groups]
dev = [\"pytest>=9,<10\", \"ruff>=0.15,<0.16\", \"ty>=0.0.24,<0.1\"]

[tool.hatch.build.targets.wheel]
packages = [\"src/{module_name}\"]

[tool.uv.workspace]

[tool.ruff]
target-version = \"py312\"
line-length = 100
src = [\"src\", \"tests\"]

[tool.ruff.lint]
select = [\"ALL\"]
ignore = [\"COM812\", \"D203\", \"D213\"]

[tool.ruff.lint.per-file-ignores]
\"tests/**\" = [\"D\", \"S101\"]

[tool.ruff.lint.pydocstyle]
convention = \"pep257\"

[tool.pytest.ini_options]
addopts = [\"--strict-config\", \"--strict-markers\"]
testpaths = [\"tests\"]

[tool.ty.environment]
python-version = \"3.12\"
root = [\"./src\"]
"""

AMBIGUITY_CLARIFICATION = Clarification(
    question=(
        "Should `limit` apply to raw input rows before filtering and deterministic ordering, or "
        "to emitted active records after filtering and deterministic ordering?"
    ),
    answer=(
        "`limit` counts emitted active records after filtering and deterministic ordering, not "
        "input rows."
    ),
)

FIXTURE_MAKEFILE = """.PHONY: install format lint type test all

install:
\tuv sync

format:
\tuv run ruff format .

lint:
\tuv run ruff check . --fix --ignore-noqa

type:
\tuv run ty check

test:
\tuv run pytest -v

all: format lint type test
"""


@dataclass(frozen=True)
class FixtureDefinition:
    """Static inputs used to construct one seed and its external acceptance suite."""

    fixture: Fixture
    package_name: str
    module_name: str
    description: str
    prompt: str
    files: dict[str, str]
    hidden_files: dict[str, str]
    documentation_required: bool = False
    clarification: Clarification | None = None


def _localized_bug() -> FixtureDefinition:
    """Build the localized defect fixture definition.

    Returns:
        FixtureDefinition: Localized fixture source and acceptance tests.
    """
    return FixtureDefinition(
        fixture=Fixture.LOCALIZED_BUG,
        package_name="identifier-tools",
        module_name="identifier_tools",
        description="Small identifier normalization library",
        prompt=(
            "Fix `normalize_identifier` so it implements the documented API. Keep the public API "
            "small, update documentation if behavior changes, and run the full project gate."
        ),
        files={
            "README.md": """# Identifier tools

`normalize_identifier(value)` returns a lowercase ASCII identifier. It trims surrounding
whitespace, treats every run of non-alphanumeric characters as one `-`, transliterates Unicode
where possible, strips boundary separators, and raises `ValueError` when nothing remains.
""",
            "src/identifier_tools/__init__.py": '''"""Public identifier normalization API."""\n\nfrom __future__ import annotations\n\nfrom identifier_tools.normalize import normalize_identifier\n\n__all__ = ["normalize_identifier"]\n''',
            "src/identifier_tools/normalize.py": '''"""Normalize human-readable labels for stable identifiers.\n\nReferences:\n- https://docs.python.org/3/library/stdtypes.html\n"""\n\nfrom __future__ import annotations\n\n\ndef normalize_identifier(value: str) -> str:\n    """Return a lowercase ASCII identifier.\n\n    Parameters:\n        value (str): Human-readable label.\n\n    Returns:\n        str: Normalized identifier.\n\n    Raises:\n        ValueError: If no identifier characters remain.\n    """\n    if not value.strip():\n        msg = "Identifier cannot be empty"\n        raise ValueError(msg)\n    return value.strip().lower().replace(" ", "-")\n''',
            "tests/test_normalize.py": """from __future__ import annotations\n\nimport pytest\n\nfrom identifier_tools import normalize_identifier\n\n\ndef test_normalizes_punctuation_run() -> None:\n    assert normalize_identifier("  Hello,   World!  ") == "hello-world"\n\n\ndef test_rejects_blank_value() -> None:\n    with pytest.raises(ValueError, match="cannot be empty"):\n        normalize_identifier("   ")\n""",
        },
        hidden_files={
            "test_acceptance.py": """from __future__ import annotations\n\nimport pytest\n\nfrom identifier_tools import normalize_identifier\n\n\n@pytest.mark.parametrize(\n    ("value", "expected"),\n    [("Crème brûlée", "creme-brulee"), ("a___b...c", "a-b-c"), ("--A--", "a")],\n)\ndef test_complete_normalization_contract(value: str, expected: str) -> None:\n    assert normalize_identifier(value) == expected\n\n\ndef test_rejects_punctuation_only() -> None:\n    with pytest.raises(ValueError):\n        normalize_identifier("...---___")\n"""
        },
    )


def _cross_file_feature() -> FixtureDefinition:
    """Build the cross-file feature fixture definition.

    Returns:
        FixtureDefinition: Cross-file fixture source and acceptance tests.
    """
    return FixtureDefinition(
        fixture=Fixture.CROSS_FILE_FEATURE,
        package_name="service-settings",
        module_name="service_settings",
        description="Typed service setting loader",
        prompt=(
            "Add `Settings.from_sources(file_values, environ)` per the README. Wire the CLI to use "
            "the same API, preserve strict validation, update README documentation for the "
            "completed behavior, and run the full project gate."
        ),
        files={
            "README.md": """# Service settings

`Settings.from_sources(file_values, environ)` merges file values with `APP_DEBUG` and
`APP_TIMEOUT` environment overrides. Environment values win. Unknown keys are rejected, booleans
accept only `true` or `false`, and timeout must be a positive integer. `python -m service_settings`
prints canonical JSON produced through this API.
""",
            "src/service_settings/__init__.py": '''"""Public service-settings API."""\n\nfrom __future__ import annotations\n\nfrom service_settings.settings import Settings\n\n__all__ = ["Settings"]\n''',
            "src/service_settings/settings.py": '''"""Typed service settings.\n\nReferences:\n- https://docs.python.org/3/library/dataclasses.html\n"""\n\nfrom __future__ import annotations\n\nfrom dataclasses import dataclass\nfrom typing import Any\n\n\n@dataclass(frozen=True)\nclass Settings:\n    """Validated runtime settings."""\n\n    debug: bool = False\n    timeout: int = 30\n\n    @classmethod\n    def from_sources(\n        cls, file_values: dict[str, Any], environ: dict[str, str]\n    ) -> Settings:\n        """Build settings from file and environment sources.\n\n        Parameters:\n            file_values (dict[str, Any]): File-derived settings.\n            environ (dict[str, str]): Environment variables.\n\n        Returns:\n            Settings: Validated merged settings.\n\n        Raises:\n            NotImplementedError: Until source merging is implemented.\n        """\n        msg = f"Source merging is not implemented for {len(file_values) + len(environ)} values"\n        raise NotImplementedError(msg)\n\n    @classmethod\n    def from_mapping(cls, values: dict[str, Any]) -> Settings:\n        """Build settings from one mapping.\n\n        Parameters:\n            values (dict[str, Any]): Raw settings.\n\n        Returns:\n            Settings: Validated settings.\n\n        Raises:\n            ValueError: If a value is invalid or unknown.\n        """\n        unknown = set(values) - {"debug", "timeout"}\n        if unknown:\n            msg = f"Unknown settings: {sorted(unknown)}"\n            raise ValueError(msg)\n        debug = values.get("debug", False)\n        timeout = values.get("timeout", 30)\n        if not isinstance(debug, bool):\n            msg = "`debug` must be a boolean"\n            raise TypeError(msg)\n        if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout <= 0:\n            msg = "`timeout` must be a positive integer"\n            raise ValueError(msg)\n        return cls(debug=debug, timeout=timeout)\n''',
            "src/service_settings/__main__.py": '''"""Print service settings as JSON."""\n\nfrom __future__ import annotations\n\nimport json\nimport sys\n\nfrom service_settings import Settings\n\n\ndef main() -> None:\n    """Print default settings."""\n    settings = Settings.from_mapping({})\n    payload = json.dumps({"debug": settings.debug, "timeout": settings.timeout}, sort_keys=True)\n    sys.stdout.write(f"{payload}\\n")\n\n\nif __name__ == "__main__":\n    main()\n''',
            "tests/test_settings.py": """from __future__ import annotations\n\nfrom service_settings import Settings\n\nTIMEOUT = 2\n\n\ndef test_environment_overrides_file_values() -> None:\n    settings = Settings.from_sources(\n        {"debug": False, "timeout": 10},\n        {"APP_DEBUG": "true", "APP_TIMEOUT": "45"},\n    )\n    assert settings == Settings(debug=True, timeout=45)\n\n\ndef test_existing_mapping_validation() -> None:\n    assert Settings.from_mapping({"timeout": TIMEOUT}).timeout == TIMEOUT\n""",
        },
        hidden_files={
            "test_acceptance.py": """from __future__ import annotations\n\nimport json\nimport subprocess\nimport sys\nfrom pathlib import Path\n\nimport pytest\nimport service_settings\nfrom service_settings import Settings\n\n\ndef test_rejects_noncanonical_environment_boolean() -> None:\n    with pytest.raises(ValueError):\n        Settings.from_sources({}, {"APP_DEBUG": "1"})\n\n\ndef test_rejects_unknown_file_key() -> None:\n    with pytest.raises(ValueError):\n        Settings.from_sources({"extra": 1}, {})\n\n\ndef test_cli_uses_environment_source() -> None:\n    package = Path(service_settings.__file__).resolve()\n    env = {\n        "APP_DEBUG": "true",\n        "APP_TIMEOUT": "9",\n        "PYTHONPATH": str(package.parents[1]),\n    }\n    output = subprocess.check_output(\n        [sys.executable, "-m", "service_settings"], text=True, env=env\n    )\n    assert json.loads(output) == {"debug": True, "timeout": 9}\n"""
        },
        documentation_required=True,
    )


def _ambiguity_heavy_change() -> FixtureDefinition:
    """Build the ambiguity-heavy fixture definition.

    Returns:
        FixtureDefinition: Ambiguous fixture source and acceptance tests.
    """
    return FixtureDefinition(
        fixture=Fixture.AMBIGUITY_HEAVY_CHANGE,
        package_name="record-summary",
        module_name="record_summary",
        description="Deterministic active-record summaries",
        prompt=(
            "Add the requested `limit` support to `summarize`. One high-impact product choice is "
            "intentionally unresolved: whether `limit` applies to raw input rows before filtering "
            "and ordering, or to returned records after filtering and ordering. Ask the operator "
            "which behavior to implement and wait for clarification. Do not guess. Preserve every "
            "other documented behavior and run the full project gate."
        ),
        files={
            "README.md": """# Record summary

`summarize(records, *, limit=None)` filters inactive records, orders remaining records by descending
score and then ascending name, and returns names. One product choice remains unresolved: whether
`limit` applies to raw input rows before filtering and ordering, or to returned records after that
pipeline. Ask the operator which behavior to implement and wait for clarification. Do not guess.

`limit` must be an integer or `None`; booleans and negative values are invalid. `None` means
unlimited. Zero returns immediately without consuming the input. Otherwise, the input iterable is
consumed once and is never mutated.
""",
            "src/record_summary/__init__.py": '''"""Public record summary API."""\n\nfrom __future__ import annotations\n\nfrom record_summary.summary import Record, summarize\n\n__all__ = ["Record", "summarize"]\n''',
            "src/record_summary/summary.py": '''"""Create deterministic record summaries.\n\nReferences:\n- https://docs.python.org/3/howto/sorting.html\n"""\n\nfrom __future__ import annotations\n\nfrom dataclasses import dataclass\nfrom typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from collections.abc import Iterable\n\n\n@dataclass(frozen=True)\nclass Record:\n    """One scored record."""\n\n    name: str\n    score: int\n    active: bool = True\n\n\ndef summarize(records: Iterable[Record], *, limit: int | None = None) -> list[str]:\n    """Return active record names in deterministic score order.\n\n    Parameters:\n        records (Iterable[Record]): Records to summarize.\n        limit (int | None): Requested maximum under the selected product behavior.\n\n    Returns:\n        list[str]: Ordered active names.\n    """\n    _ = limit\n    active = (record for record in records if record.active)\n    ordered = sorted(active, key=lambda record: (-record.score, record.name))\n    return [record.name for record in ordered]\n''',
            "tests/test_summary.py": """from __future__ import annotations\n\nfrom record_summary import Record, summarize\n\n\ndef test_limit_supports_unambiguous_ordered_active_input() -> None:\n    records = [Record("high", 10), Record("low", 1)]\n    assert summarize(records, limit=1) == ["high"]\n\n\ndef test_existing_order_is_deterministic() -> None:\n    assert summarize([Record("z", 2), Record("a", 2)]) == ["a", "z"]\n""",
        },
        hidden_files={
            "test_acceptance.py": """from __future__ import annotations\n\nfrom collections.abc import Iterator\n\nimport pytest\n\nfrom record_summary import Record, summarize\n\n\ndef test_limit_is_after_filter_and_sort() -> None:\n    records = [Record("inactive", 100, False), Record("low", 1), Record("high", 9)]\n    assert summarize(iter(records), limit=1) == ["high"]\n\n\ndef test_input_list_is_not_mutated() -> None:\n    records = [Record("z", 2), Record("a", 2), Record("off", 9, False)]\n    original = records.copy()\n    assert summarize(records, limit=2) == ["a", "z"]\n    assert records == original\n\n\ndef test_one_shot_iterable_is_consumed_once() -> None:\n    class OneShot:\n        def __init__(self) -> None:\n            self.iterations = 0\n\n        def __iter__(self) -> Iterator[Record]:\n            self.iterations += 1\n            if self.iterations > 1:\n                raise AssertionError("iterable consumed more than once")\n            yield Record("low", 1)\n            yield Record("high", 9)\n\n    records = OneShot()\n    assert summarize(records, limit=1) == ["high"]\n    assert records.iterations == 1\n\n\ndef test_zero_limit_does_not_consume_generator() -> None:\n    consumed = False\n\n    def records() -> Iterator[Record]:\n        nonlocal consumed\n        consumed = True\n        yield Record("unused", 1)\n\n    assert summarize(records(), limit=0) == []\n    assert not consumed\n\n\n@pytest.mark.parametrize("limit", [-1, True, False, "1", 1.5])\ndef test_rejects_invalid_limit(limit: object) -> None:\n    with pytest.raises((TypeError, ValueError)):\n        summarize([], limit=limit)\n\n\ndef test_order_is_deterministic() -> None:\n    records = [Record("z", 3), Record("b", 5), Record("a", 5), Record("off", 99, False)]\n    assert summarize((record for record in records), limit=3) == ["a", "b", "z"]\n"""
        },
        clarification=AMBIGUITY_CLARIFICATION,
    )


DEFINITIONS = {
    definition.fixture: definition
    for definition in (_localized_bug(), _cross_file_feature(), _ambiguity_heavy_change())
}


def _write_files(root: Path, files: dict[str, str]) -> None:
    """Write a relative file map beneath one root.

    Parameters:
        root (Path): Existing or creatable output root.
        files (dict[str, str]): Relative paths and UTF-8 contents.
    """
    for relative, content in files.items():
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content, encoding="utf-8")


def _initialize_git(seed_dir: Path) -> str:
    """Create a deterministic git commit and return its SHA.

    Parameters:
        seed_dir (Path): Generated seed directory.

    Returns:
        str: Commit SHA.
    """
    git = executable("git")
    output([str(git), "init", "--initial-branch=main"], cwd=seed_dir)
    output([str(git), "add", "."], cwd=seed_dir)
    env = {
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "LANG": "C",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_AUTHOR_NAME": "Benchmark Fixture",
        "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
        "GIT_COMMITTER_NAME": "Benchmark Fixture",
        "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
        "GIT_AUTHOR_DATE": "2025-01-01T00:00:00+00:00",
        "GIT_COMMITTER_DATE": "2025-01-01T00:00:00+00:00",
    }
    try:
        subprocess.check_output(
            [str(git), "commit", "-m", "Create benchmark seed"],
            cwd=seed_dir,
            env=env,
            text=True,
            stderr=subprocess.STDOUT,
        )
    except subprocess.CalledProcessError as exc:
        msg = f"Could not commit fixture '{seed_dir.name}': {exc.output.strip()}"
        raise RuntimeError(msg) from exc
    return output([str(git), "rev-parse", "HEAD"], cwd=seed_dir).strip()


def generate_fixtures(workspace: Path, *, force: bool = False) -> dict[Fixture, str]:
    """Generate all pristine seed repos and external hidden tests.

    Parameters:
        workspace (Path): Benchmark workspace root.
        force (bool): Replace existing generated fixtures when true.

    Returns:
        dict[Fixture, str]: Fixture-to-seed-commit mapping.

    Raises:
        FileExistsError: If generated output exists and force is false.
    """
    workspace = Path(str(workspace)).resolve()
    seeds_root = workspace / "seeds"
    hidden_root = workspace / "hidden"
    existing = [path for path in (seeds_root, hidden_root) if path.exists()]
    if existing and not force:
        msg = f"Generated fixture path already exists: '{existing[0]}'"
        raise FileExistsError(msg)
    if force:
        for path in existing:
            shutil.rmtree(path)

    commits: dict[Fixture, str] = {}
    for fixture, definition in DEFINITIONS.items():
        seed_dir = seeds_root / fixture.value
        hidden_dir = hidden_root / fixture.value
        seed_dir.mkdir(parents=True)
        _write_files(
            seed_dir,
            {
                "pyproject.toml": FIXTURE_PYPROJECT.format(
                    package_name=definition.package_name,
                    module_name=definition.module_name,
                    description=definition.description,
                ),
                "Makefile": FIXTURE_MAKEFILE,
                ".gitignore": (
                    ".coverage\n.pytest_cache/\n.ruff_cache/\n.ty_cache/\n.venv/\n__pycache__/\n"
                ),
                "TASK.md": f"# Task\n\n{definition.prompt}\n",
            }
            | definition.files,
        )
        _write_files(hidden_dir, definition.hidden_files)
        uv = executable("uv")
        output([str(uv), "lock"], cwd=seed_dir)
        output([str(uv), "run", "--frozen", "ruff", "format", "."], cwd=seed_dir)
        commits[fixture] = _initialize_git(seed_dir)
    return commits


def fixture_prompt(fixture: Fixture) -> str:
    """Return the exact operator prompt for a fixture.

    Parameters:
        fixture (Fixture): Fixture identifier.

    Returns:
        str: Benchmark task prompt.
    """
    return DEFINITIONS[fixture].prompt
