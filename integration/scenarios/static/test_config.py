"""Static checks on the chezmoi-rendered pi config, installed pins, and the Brew pin chain."""

from __future__ import annotations

import json
import re
import shutil
import stat
import subprocess
from pathlib import Path
from typing import Any

import pytest

from harness.config_checks import (
    brewfile_pin,
    checkout_matches_ref,
    formula_version,
    git_pins,
    pi_package_dir,
    pi_settings_keys,
)
from harness.paths import LIVE_AGENT_DIR, chezmoi_source, pi_command

pytestmark = pytest.mark.static

_BREW_PREFIX = Path(shutil.which("brew") or "/opt/homebrew/bin/brew").resolve().parent.parent
BREW_TAP_FORMULA = _BREW_PREFIX / "Library/Taps/nredd/homebrew-tap/Formula/pi-coding-agent.rb"
INTERPRETERS = frozenset({"sh", "bash", "zsh", "fish", "python", "python3", "node", "perl", "ruby", "eval"})
REA_PIN = re.compile(r"rea-agents@(\d+\.\d+\.\d+)\b")
REA_SKILL_FILES = (
    "SKILL.md",
    "references/android-applications.md",
    "references/connection-and-recovery.md",
    "references/evidence-workflows.md",
    "references/javascript-applications.md",
    "references/native-and-artifacts.md",
    "references/runtime-observation.md",
)


def test_settings_keys_are_known_to_pi(rendered_settings: dict[str, Any]) -> None:
    """Every top-level settings key is one pi declares; extension blobs belong elsewhere."""
    known = pi_settings_keys(pi_package_dir(pi_command()))
    unknown = sorted(set(rendered_settings) - known)
    assert not unknown, f"Unknown settings keys: {unknown}"


def test_no_compaction_overrides_or_kendex(rendered_settings: dict[str, Any]) -> None:
    """`compaction.modelOverrides` never applied to `router/*`, and `kendex` was the dropped renderer."""
    assert "modelOverrides" not in rendered_settings.get("compaction", {})
    assert "kendex" not in rendered_settings
    assert not any("pi-tool-renderer" in str(package) for package in rendered_settings.get("packages", []))


def test_quiet_startup_header(rendered_settings: dict[str, Any]) -> None:
    """Startup keeps the header but hides the resource listing."""
    assert rendered_settings.get("quietStartup") == "header"


def test_installed_git_pins_match_chezmoi(rendered_settings: dict[str, Any]) -> None:
    """Each installed `git:` package checkout sits on the ref chezmoi pins."""
    pins = git_pins(rendered_settings.get("packages", []))
    assert pins, "No pinned git packages in settings"
    mismatches = []
    for pin in pins:
        checkout = LIVE_AGENT_DIR / "git" / pin.host / pin.owner / pin.repo
        matches, detail = checkout_matches_ref(checkout, pin.ref)
        if not matches:
            mismatches.append(f"{pin.repo}: {detail}")
    assert not mismatches, "Installed pins drifted from chezmoi:\n" + "\n".join(mismatches)


def test_brew_pin_chain_is_consistent() -> None:
    """Brewfile `# pinned:` == tap formula version == the installed `pi --version`."""
    brewfile = (chezmoi_source() / "dot_config" / "homebrew" / "Brewfile.tmpl").read_text()
    pin = brewfile_pin(brewfile)
    version = formula_version(BREW_TAP_FORMULA.read_text())
    assert pin == f"v{version}", f"Brewfile pins '{pin}' but the tap formula is '{version}'"
    installed_pi = shutil.which("pi")
    assert installed_pi is not None, "No `pi` on PATH"
    reported = subprocess.check_output([installed_pi, "--version"], text=True).strip()
    assert version.split("-nredd.")[0] == reported, (
        f"Formula '{version}' but `pi --version` says '{reported}'"
    )


def test_workflows_keyword_trigger_is_off(template_home: Path) -> None:
    """The workflows keyword trigger arms on any mention of the word, so it stays off."""
    path = template_home / ".pi" / "workflows" / "settings.json"
    assert path.is_file(), "chezmoi does not manage `~/.pi/workflows/settings.json`"
    assert json.loads(path.read_text()).get("keywordTriggerEnabled") is False


def test_plan_mode_prefixes_never_approve_a_whole_command(template_home: Path) -> None:
    """No `safeSubcommands` entry is empty or names an interpreter, either of which approves anything."""
    plan_settings = json.loads((template_home / ".pi" / "agent" / "pi-plan-mode.json").read_text())
    safe = plan_settings.get("safeSubcommands", {})
    problems = [f"`{command}` is an interpreter" for command in safe if command in INTERPRETERS]
    problems += [
        f"`{command}` has an empty prefix"
        for command, prefixes in safe.items()
        if any(not str(prefix).strip() for prefix in prefixes)
    ]
    assert not problems, "\n".join(problems)


def test_plan_mode_trusts_code_and_chezmoi(template_home: Path) -> None:
    """`cd` and `git -C` into `~/code` and the chezmoi source are allowed while planning."""
    plan_settings = json.loads((template_home / ".pi" / "agent" / "pi-plan-mode.json").read_text())
    assert set(plan_settings.get("trustedDirectories", [])) >= {"~/code", "~/.local/share/chezmoi"}


def test_subagents_default_model_is_router(template_home: Path) -> None:
    """Personal machines route every subagent through `router/default` unless a param overrides it."""
    subagents = json.loads((template_home / ".pi" / "agent" / "subagents.json").read_text())
    work_machine = not any(
        "pi-subscription-router" in str(package)
        for package in json.loads((template_home / ".pi" / "agent" / "settings.json").read_text()).get(
            "packages", []
        )
    )
    if work_machine:
        assert "*" not in subagents.get("agentModels", {})
    else:
        assert subagents.get("agentModels", {}).get("*") == "router/default"
    agent = (template_home / ".pi" / "agent" / "agents" / "general-purpose.md").read_text()
    frontmatter = agent.split("---")[1] if agent.startswith("---") else ""
    assert "model:" not in frontmatter, "`general-purpose.md` pins a model, which beats `agentModels`"


def _rea_pins(text: str) -> set[str]:
    """Return every exact `rea-agents@X.Y.Z` version named in `text`.

    Parameters:
        text (str): file contents.

    Returns:
        set[str]: distinct pinned versions.
    """
    return set(REA_PIN.findall(text))


def test_mcp_rea_server_is_pinned_and_codemode(template_home: Path) -> None:
    """`mcp.json` is strict JSON with exactly the `rea` stdio server on an exact `npx` pin."""
    path = template_home / ".pi" / "agent" / "mcp.json"
    assert path.is_file(), "chezmoi does not manage `~/.pi/agent/mcp.json`"
    config = json.loads(path.read_text())
    servers = config.get("mcpServers", {})
    assert set(servers) == {"rea"}, f"unexpected MCP servers: {sorted(servers)}"
    rea = servers["rea"]
    assert rea.get("command") == "npx"
    args = rea.get("args", [])
    assert len(args) == 3, args
    assert args[0] == "-y", args
    assert args[2] == "mcp", args
    assert REA_PIN.fullmatch(args[1]), f"`rea-agents` must be pinned to an exact version, got {args[1]!r}"
    assert "exposure" not in rea, "`rea` relies on pi's default `codemode` exposure"
    assert rea.get("enabled", True) is True


def test_rea_skill_is_vendored_at_the_server_version(template_home: Path) -> None:
    """The vendored skill, its README entry and the warm script name the same `rea-agents` version."""
    source = chezmoi_source()
    skill = source / "private_dot_agents" / "skills" / "reverse-engineer-anything"
    missing = [name for name in REA_SKILL_FILES if not (skill / name).is_file()]
    assert not missing, f"vendored REA skill is missing {missing}"
    assert not skill.is_symlink(), "REA refuses symlinked skill directories"
    mcp = json.loads((template_home / ".pi" / "agent" / "mcp.json").read_text())
    pinned = _rea_pins(" ".join(mcp["mcpServers"]["rea"]["args"]))
    readme_pins = _rea_pins((source / "private_dot_agents" / "skills" / "README.md").read_text())
    warm_pins = _rea_pins((source / "run_onchange_after_warm-rea-agents.sh.tmpl").read_text())
    assert readme_pins == pinned, f"skills README pins {readme_pins}, mcp.json pins {pinned}"
    assert warm_pins == pinned, f"warm script pins {warm_pins}, mcp.json pins {pinned}"


ENTERPRISE_MANIFEST = LIVE_AGENT_DIR / "enterprise.local.json"
ENTERPRISE_SECTIONS = ("settings", "models", "subagents")


@pytest.mark.skipif(not ENTERPRISE_MANIFEST.is_file(), reason="no enterprise manifest on this machine")
def test_enterprise_manifest_shape() -> None:
    """Work machine: the manifest is read in place and only its key shape is checked, never its values."""
    mode = stat.S_IMODE(ENTERPRISE_MANIFEST.stat().st_mode)
    assert not mode & 0o077, f"`enterprise.local.json` grants group/other access: {oct(mode)}"
    manifest = json.loads(ENTERPRISE_MANIFEST.read_text())
    assert isinstance(manifest, dict)
    assert manifest.get("version") == 1
    for section in ENTERPRISE_SECTIONS:
        assert section not in manifest or isinstance(manifest[section], dict), f"`{section}` is not an object"
    settings = manifest.get("settings", {})
    for key in ("defaultProvider", "defaultModel"):
        value = settings.get(key)
        assert isinstance(value, str), f"`settings.{key}` must be a string"
        assert value, f"`settings.{key}` must be non-empty"
