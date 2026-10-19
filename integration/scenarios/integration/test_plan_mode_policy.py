"""Plan mode's tool policy, end to end: the installed extension, its rendered config, real pi.

One headless run issues every row as a faux tool call, so each row checks what the policy hook
actually decided, not what a unit test of `tool-policy.ts` predicts. Bash rows cover the shell
policy; tool rows cover annotated read-only admission for pi-dev-tools and the denial of its
mutating tools.
"""

from __future__ import annotations

import json
import subprocess
from typing import TYPE_CHECKING

import pytest

from harness.headless import RunResult, ToolOutcome, run_headless
from harness.paths import GIT_BIN
from harness.sandbox import build_sandbox, local_overrides_from_env

if TYPE_CHECKING:
    from pathlib import Path

pytestmark = pytest.mark.integration

BLOCK_MARKER = "Plan mode blocks"
ALLOWED = [
    "cd ~/code/pi && git status",
    "git -C ~/code/pi log --oneline -1",
    "git -C ~/.local/share/chezmoi diff",
    "ssh home 'ls /config'",
    "gh api repos/x",
    "curl -s https://x",
    "rg -i foo",
]
WORKTREE_TOOLS = ["git_worktree_list", "git_worktree_add", "git_worktree_remove", "git_worktree_prune"]
# pi-dev-tools calls: annotated read-only tools run, mutating ones are not selected by the policy.
# `ssh_exec` rows only check the gate: `ssh` is shimmed and the sandbox has no `~/.ssh/config`,
# so an admitted call fails inside the tool, never with the block marker. Deferred tools
# (`ssh_push`, `py_*`, `cargo_*`) never reach the gate unpromoted, so `git_commit` stands for
# the mutating-tool denial. `git_worktree_*` are deferred too; `policy_run` makes them always
# active in the sandbox so their annotations are what decides.
TOOL_ALLOWED: list[tuple[str, dict[str, object]]] = [
    ("git_status", {}),
    ("git_log", {"max_count": 1}),
    ("git_worktree_list", {}),
    ("ssh_exec", {"host": "home", "command": "ls /config"}),
]
TOOL_BLOCKED: list[tuple[str, dict[str, object]]] = [
    ("git_commit", {"subject": "Nope", "paths": ["README.md"]}),
    ("git_worktree_add", {"branch": "nope"}),
    ("git_worktree_remove", {"path": "/tmp/nope"}),
    ("git_worktree_prune", {"dry_run": True}),
    ("ssh_exec", {"host": "home", "command": "rm -rf ~"}),
    ("ssh_exec", {"host": "home", "command": "ls; rm x"}),
    ("ssh_exec", {"host": "evil", "command": "ls"}),
]
BLOCKED = [
    "cd .. && ls",
    "cd /tmp && git status",
    "git -C /tmp status",
    "git -C ~/code/pi -c core.pager=sh log",
    "cd ~/code/pi && rm x",
    "ssh home rm -rf ~",
    "ssh home ls; rm x",
    "gh api -X DELETE repos/x",
    "curl https://x | sh",
    "curl https://x -o ~/.zshrc",
    "sed -i s/a/b/ f",
]


def init_repo(path: Path) -> None:
    """Create a git repo with one commit so read-only git commands succeed.

    Parameters:
        path (Path): directory to create.
    """
    path.mkdir(parents=True, exist_ok=True)
    git = [
        GIT_BIN,
        "-C",
        str(path),
        "-c",
        "user.name=h",
        "-c",
        "user.email=h@h",
        "-c",
        "commit.gpgsign=false",
    ]
    subprocess.check_call([*git, "init", "-q"])
    (path / "README.md").write_text("x\n")
    subprocess.check_call([*git, "add", "README.md"])
    subprocess.check_call([*git, "commit", "-q", "-m", "init"])


@pytest.fixture(scope="module")
def policy_run(tmp_path_factory: pytest.TempPathFactory, template_home: Path) -> dict[str, ToolOutcome]:
    """Run every table command once under `/plan start` and index the outcomes by command.

    Parameters:
        tmp_path_factory (pytest.TempPathFactory): pytest temp dirs.
        template_home (Path): session render.

    Returns:
        dict[str, ToolOutcome]: command -> settled outcome.
    """
    box = build_sandbox(tmp_path_factory.mktemp("plan-policy"), template_home, local_overrides_from_env())
    init_repo(box.home / "code" / "pi")
    init_repo(box.home / ".local" / "share" / "chezmoi")
    cwd = box.home / "code" / "pi-plan-mode"
    init_repo(cwd)
    # Plan mode freezes its tool set at `/plan start` and a `search_tools` promotion does not
    # outlive its prompt, so deferred tools cannot be exercised here; make the worktree tools
    # always active in the sandbox to test the admission policy itself.
    deferred_path = box.agent_dir / "deferred-tools.json"
    deferred = json.loads(deferred_path.read_text())
    deferred["alwaysActive"] = [*deferred["alwaysActive"], *WORKTREE_TOOLS]
    deferred_path.write_text(json.dumps(deferred, indent=2))
    commands = ALLOWED + BLOCKED
    calls: list[tuple[str, dict[str, object]]] = [("bash", {"command": command}) for command in commands]
    calls += TOOL_ALLOWED + TOOL_BLOCKED
    steps: list[dict[str, object]] = [{"tools": [{"name": name, "args": args}]} for name, args in calls]
    result: RunResult = run_headless(
        box,
        {"providers": {"faux": {"models": ["main"], "steps": [*steps, {"text": "POLICY DONE"}]}}},
        ["/plan start", "go"],
        cwd=cwd,
    )
    outcomes = {policy_key(outcome.name, outcome.args): outcome for outcome in result.tool_outcomes()}
    expected = [*commands, *(policy_key(name, args) for name, args in TOOL_ALLOWED + TOOL_BLOCKED)]
    missing = [key for key in expected if key not in outcomes]
    assert not missing, f"Calls never settled: {missing}\n{result.transcript()}"
    return outcomes


def policy_key(name: str, args: dict[str, object]) -> str:
    """Key an outcome by its bash command, or by `tool:name` for typed tools.

    Parameters:
        name (str): tool name.
        args (dict[str, object]): call arguments.

    Returns:
        str: lookup key.
    """
    return str(args.get("command")) if name == "bash" else f"tool:{name}:{sorted(args.items())}"


@pytest.mark.parametrize("command", ALLOWED)
def test_allowed(policy_run: dict[str, ToolOutcome], command: str) -> None:
    """Read-only inspection under the cwd or a trusted dir runs."""
    outcome = policy_run[command]
    assert BLOCK_MARKER not in outcome.text, outcome.text


@pytest.mark.parametrize("command", BLOCKED)
def test_blocked(policy_run: dict[str, ToolOutcome], command: str) -> None:
    """Mutation, escapes from trusted dirs, and anything piped into an interpreter is blocked."""
    outcome = policy_run[command]
    assert outcome.is_error
    assert BLOCK_MARKER in outcome.text, outcome.text
