"""Extension output reaches actual text/JSON CLI channels outside the TUI.

References:
- https://github.com/nredd/pi-harness/blob/main/packages/session-kit/README.md
"""

from __future__ import annotations

import json
import subprocess
from typing import TYPE_CHECKING

import pytest

from harness.git_fixture import git
from harness.headless import content_text, run_headless
from harness.paths import FAUX_EXTENSION, pi_command
from harness.session_kit import STATS_MODELS, seed_stats_sessions

if TYPE_CHECKING:
    from harness.sandbox import Sandbox

pytestmark = pytest.mark.stack


@pytest.mark.parametrize("mode", ["text", "json"])
def test_diff_prints_the_stat_outside_the_tui(sandbox: Sandbox, mode: str) -> None:
    """Real diff, bad-ref notification and seeded stats all route through CLI output without a UI.

    Parameters:
        sandbox (Sandbox): private stack, git repository and seeded stats history.
        mode (str): text or JSON CLI channel.
    """
    repo = sandbox.workdir
    git(repo, "init", "-q")
    (repo / "a.txt").write_text("x\n")
    git(repo, "add", "a.txt")
    git(repo, "commit", "-q", "-m", "Initial")
    (repo / "a.txt").write_text("y\n")
    (repo / "new.txt").write_text("z\n")
    seed_stats_sessions(sandbox.agent_dir)
    payload = {"providers": {"faux": {"models": ["main"], "steps": []}}}
    script = sandbox.root / "print-script.json"
    script.write_text(json.dumps(payload))
    outputs = []
    for command in ("/diff", "/diff no-such-ref-xyz", "/stats"):
        if mode == "json":
            result = run_headless(sandbox, payload, [command])
            assert result.returncode == 0, result.transcript()
            assert not result.stdout_noise
            visible = [
                event["message"]
                for event in result.of_type("message_end")
                if event.get("message", {}).get("customType") in {"session-kit:diff", "session-kit:stats"}
            ]
            outputs.append(
                "\n".join(content_text(message.get("content")) for message in visible) + result.stderr
            )
        else:
            done = subprocess.run(
                [*pi_command(), "-e", str(FAUX_EXTENSION), "--model", "faux/main", "-p", command],
                cwd=repo,
                env=sandbox.env({"HARNESS_SCRIPT": str(script)}),
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
            assert done.returncode == 0, done.stderr
            outputs.append(done.stdout + done.stderr)
    good, bad, stats = outputs
    assert "a.txt" in good, good
    assert "?? new.txt" in good, good
    assert "/diff:" in bad, bad
    assert "no-such-ref-xyz" in bad, bad
    assert "tokens (in + out + cache), all time" in stats, stats
    for _, model, _ in STATS_MODELS:
        assert model in stats, stats
    assert "faux" not in stats.split("all time", 1)[1], stats
    assert "router" not in stats, stats
    # Accounting is native; this only proves the real table went to a visible CLI channel.
    assert (sandbox.agent_dir / "pi-session-kit/stats-cache.json").is_file()
