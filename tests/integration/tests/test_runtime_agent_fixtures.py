"""Exercise stack scenarios' shared agent-fixture lookup before any process launch.

References:
- https://github.com/nredd/pi-harness/issues/884
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from harness.sandbox import build_sandbox
from scenarios import test_stack as stack_scenarios

if TYPE_CHECKING:
    from typing import Never

    from harness.sandbox import Sandbox


@pytest.mark.parametrize(
    ("agent_type", "without_web"), [("Explore", False), ("architect", False), ("architect", True)]
)
def test_runtime_agent_scenario_copies_the_sibling_workspace_fixture(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, agent_type: str, without_web: bool
) -> None:
    """Run the actual fixture consumer, stopping only at the subprocess boundary.

    Parameters:
        tmp_path (Path): disposable sandbox root.
        monkeypatch (pytest.MonkeyPatch): prevent launching a Pi process.
        agent_type (str): shared agent fixture selected by the real scenario.
        without_web (bool): existing negative-control fixture transformation.
    """
    fixture = (
        Path(__file__).resolve().parents[3] / "tests/inprocess/tests/fixtures/agents" / f"{agent_type}.md"
    )
    original = fixture.read_bytes()
    box = build_sandbox(tmp_path / "sandbox")

    def before_process(sandbox: Sandbox, *_args: object, **_kwargs: object) -> Never:
        """Check the real copied bytes and stop before any process starts.

        Parameters:
            sandbox (Sandbox): the real scenario's disposable sandbox.
            *_args (object): unused headless arguments.
            **_kwargs (object): unused headless options.
        Raises:
            RuntimeError: expected marker proving fixture preparation completed.
        """
        copied = (sandbox.agent_dir / "agents" / fixture.name).read_bytes()
        if without_web:
            assert b"extensions: [pi-dev-tools]\n" in copied
            assert b"extensions: [pi-dev-tools, pi-web-access]" not in copied
        else:
            assert copied == original
        raise RuntimeError("fixture preparation reached the process boundary")

    monkeypatch.setattr(stack_scenarios, "run_headless", before_process)
    with pytest.raises(RuntimeError, match="fixture preparation reached the process boundary"):
        stack_scenarios.test_runtime_agent_surfaces(box, agent_type, without_web, set())
