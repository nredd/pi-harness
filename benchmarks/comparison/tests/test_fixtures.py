from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from pi_harness_benchmark.models import Fixture
from pi_harness_benchmark.process import executable


def _run(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def test_ambiguity_seed_withholds_product_choice_and_requires_question(
    generated_workspace: Path,
) -> None:
    seed = generated_workspace / "seeds" / Fixture.AMBIGUITY_HEAVY_CHANGE.value
    git = executable("git")
    tracked = _run([str(git), "ls-files", "-z"], seed).stdout.split("\0")
    visible_text = "\n".join(
        (seed / relative).read_text(encoding="utf-8") for relative in tracked if relative
    )

    assert "limit counts emitted active records" not in visible_text.lower()
    assert "not input rows" not in visible_text.lower()
    assert "maximum emitted active records" not in visible_text.lower()
    assert "ask the operator" in visible_text.lower()
    assert "do not guess" in visible_text.lower()
    assert "wait for clarification" in visible_text.lower()


def test_ambiguity_hidden_suite_covers_full_contract(generated_workspace: Path) -> None:
    hidden = (
        generated_workspace / "hidden" / Fixture.AMBIGUITY_HEAVY_CHANGE.value / "test_acceptance.py"
    ).read_text(encoding="utf-8")

    for evidence in (
        "test_input_list_is_not_mutated",
        "test_one_shot_iterable_is_consumed_once",
        "False",
        "True",
        '"1"',
        "1.5",
        "-1",
        "limit=0",
        "not consumed",
        "test_order_is_deterministic",
    ):
        assert evidence in hidden


def test_generated_seeds_are_locked_clean_and_have_one_intended_failure(
    generated_workspace: Path,
) -> None:
    uv = executable("uv")
    git = executable("git")
    for fixture in Fixture:
        seed = generated_workspace / "seeds" / fixture.value
        assert (seed / "uv.lock").is_file()
        assert _run([str(git), "status", "--porcelain"], seed).stdout == ""
        assert (
            _run([str(uv), "run", "--frozen", "ruff", "format", "--check", "."], seed).returncode
            == 0
        )
        assert (
            _run(
                [str(uv), "run", "--frozen", "ruff", "check", "--ignore-noqa", "."], seed
            ).returncode
            == 0
        )
        assert _run([str(uv), "run", "--frozen", "ty", "check"], seed).returncode == 0

        visible = _run([str(uv), "run", "--frozen", "pytest", "-q"], seed)
        assert visible.returncode == 1
        assert "1 failed, 1 passed" in visible.stdout


@pytest.mark.parametrize(
    ("fixture", "relative_path", "old", "new"),
    [
        (
            Fixture.LOCALIZED_BUG,
            "src/identifier_tools/normalize.py",
            'return value.strip().lower().replace(" ", "-")',
            'return value.strip().lower().replace(",", "").replace("!", "").replace("   ", " ").replace(" ", "-")',
        ),
        (
            Fixture.CROSS_FILE_FEATURE,
            "src/service_settings/settings.py",
            "    @classmethod\n    def from_mapping",
            '''    @classmethod
    def from_sources(
        cls, file_values: dict[str, Any], environ: dict[str, str]
    ) -> Settings:
        """Merge file and environment settings."""
        merged = file_values.copy()
        if "APP_DEBUG" in environ:
            merged["debug"] = environ["APP_DEBUG"] == "true"
        if "APP_TIMEOUT" in environ:
            merged["timeout"] = int(environ["APP_TIMEOUT"])
        return cls.from_mapping(merged)

    @classmethod
    def from_mapping''',
        ),
        (
            Fixture.AMBIGUITY_HEAVY_CHANGE,
            "src/record_summary/summary.py",
            "def summarize(records: Iterable[Record]) -> list[str]:",
            "def summarize(records: Iterable[Record], *, limit: int | None = None) -> list[str]:",
        ),
    ],
)
def test_hidden_acceptance_rejects_superficial_visible_fix(
    generated_workspace: Path,
    tmp_path: Path,
    fixture: Fixture,
    relative_path: str,
    old: str,
    new: str,
) -> None:
    git = executable("git")
    uv = executable("uv")
    clone = tmp_path / fixture.value
    cloned = _run(
        [
            str(git),
            "clone",
            "--quiet",
            str(generated_workspace / "seeds" / fixture.value),
            str(clone),
        ],
        tmp_path,
    )
    assert cloned.returncode == 0, cloned.stdout
    source = clone / relative_path
    content = source.read_text(encoding="utf-8")
    if fixture is Fixture.AMBIGUITY_HEAVY_CHANGE:
        content = content.replace(old, new).replace(
            "return [record.name for record in ordered]",
            "return [record.name for record in ordered][:limit]",
        )
    else:
        content = content.replace(old, new)
    source.write_text(content, encoding="utf-8")

    visible = _run([str(uv), "run", "--frozen", "pytest", "-q"], clone)
    hidden = _run(
        [
            str(uv),
            "run",
            "--frozen",
            "pytest",
            "-q",
            str(generated_workspace / "hidden" / fixture.value),
        ],
        clone,
    )

    assert visible.returncode == 0, visible.stdout
    assert hidden.returncode == 1, hidden.stdout
    assert "ModuleNotFoundError" not in hidden.stdout
    assert "failed" in hidden.stdout


def test_ambiguity_hidden_gate_accepts_complete_contract(
    generated_workspace: Path,
    tmp_path: Path,
) -> None:
    git = executable("git")
    uv = executable("uv")
    clone = tmp_path / "complete-contract"
    cloned = _run(
        [
            str(git),
            "clone",
            "--quiet",
            str(generated_workspace / "seeds" / Fixture.AMBIGUITY_HEAVY_CHANGE.value),
            str(clone),
        ],
        tmp_path,
    )
    assert cloned.returncode == 0, cloned.stdout
    source = clone / "src/record_summary/summary.py"
    content = source.read_text(encoding="utf-8")
    original = """    _ = limit
    active = (record for record in records if record.active)
    ordered = sorted(active, key=lambda record: (-record.score, record.name))
    return [record.name for record in ordered]"""
    complete = """    if isinstance(limit, bool) or not isinstance(limit, (int, type(None))):
        msg = "`limit` must be an integer or `None`"
        raise TypeError(msg)
    if limit is not None and limit < 0:
        msg = "`limit` cannot be negative"
        raise ValueError(msg)
    if limit == 0:
        return []
    active = (record for record in records if record.active)
    ordered = sorted(active, key=lambda record: (-record.score, record.name))
    names = [record.name for record in ordered]
    return names if limit is None else names[:limit]"""
    source.write_text(content.replace(original, complete), encoding="utf-8")

    hidden = _run(
        [
            str(uv),
            "run",
            "--frozen",
            "pytest",
            "-q",
            str(generated_workspace / "hidden" / Fixture.AMBIGUITY_HEAVY_CHANGE.value),
        ],
        clone,
    )

    assert hidden.returncode == 0, hidden.stdout


@pytest.mark.parametrize(
    ("body", "hidden_exit_code"),
    [
        (
            """    selected = list(records)
    if limit is not None:
        selected = selected[:limit]
    active = (record for record in selected if record.active)
    ordered = sorted(active, key=lambda record: (-record.score, record.name))
    return [record.name for record in ordered]""",
            1,
        ),
        (
            """    active = (record for record in records if record.active)
    ordered = sorted(active, key=lambda record: (-record.score, record.name))
    names = [record.name for record in ordered]
    return names if limit is None else names[:limit]""",
            0,
        ),
    ],
)
def test_hidden_gate_distinguishes_fixed_limit_product_choice(
    generated_workspace: Path,
    tmp_path: Path,
    body: str,
    hidden_exit_code: int,
) -> None:
    git = executable("git")
    uv = executable("uv")
    clone = tmp_path / f"choice-{hidden_exit_code}"
    cloned = _run(
        [
            str(git),
            "clone",
            "--quiet",
            str(generated_workspace / "seeds" / Fixture.AMBIGUITY_HEAVY_CHANGE.value),
            str(clone),
        ],
        tmp_path,
    )
    assert cloned.returncode == 0, cloned.stdout
    source = clone / "src/record_summary/summary.py"
    content = source.read_text(encoding="utf-8")
    original = """    _ = limit
    active = (record for record in records if record.active)
    ordered = sorted(active, key=lambda record: (-record.score, record.name))
    return [record.name for record in ordered]"""
    source.write_text(content.replace(original, body), encoding="utf-8")

    visible = _run([str(uv), "run", "--frozen", "pytest", "-q"], clone)
    hidden = _run(
        [
            str(uv),
            "run",
            "--frozen",
            "pytest",
            "-q",
            str(
                generated_workspace
                / "hidden"
                / Fixture.AMBIGUITY_HEAVY_CHANGE.value
                / "test_acceptance.py"
            ),
            "-k",
            "limit_is_after_filter_and_sort",
        ],
        clone,
    )

    assert visible.returncode == 0, visible.stdout
    assert hidden.returncode == hidden_exit_code, hidden.stdout
