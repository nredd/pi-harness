"""Throwaway Pi homes populated only by explicit package sets and real `pi install`.

References:
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from harness.paths import pi_command
from harness.stack import load_stack, package_directory, stack_digest

if TYPE_CHECKING:
    from pathlib import Path

LOGGER = logging.getLogger(__name__)
BASE_ENV = {
    "TZ": "UTC",
    "LANG": "en_US.UTF-8",
    "LC_ALL": "en_US.UTF-8",
    "TERM": "xterm-256color",
    "COLORTERM": "truecolor",
    "PI_OFFLINE": "1",
    "PI_SKIP_VERSION_CHECK": "1",
    "PI_TELEMETRY": "0",
    "NO_UPDATE_NOTIFIER": "1",
    "PI_MEMORY_QMD_UPDATE": "off",
    "PI_MEMORY_EXIT_SUMMARY": "0",
    "ANTHROPIC_CLI_VERSION": "2.1.0",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_NOSYSTEM": "1",
}
# Faux providers register their own inert API keys. Generic startup/resize must not even
# offer fake subscription credentials to background usage warmup; auth D supplies its own.
FAKE_AUTH: dict[str, Any] = {}
SILENT_CHANGELOG_VERSION = "999.0.0"
SHIMMED_COMMANDS = ("ssh", "scp", "rsync", "curl", "wget", "gh", "sudo", "brew", "npm", "open")
SHIM_SCRIPT = '#!/bin/sh\necho "SHIM $(basename "$0") $*"\n'


def deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Recursively overlay objects, replacing arrays and scalars.

    Parameters:
        base (dict[str, Any]): original object.
        overlay (dict[str, Any]): winning values.

    Returns:
        dict[str, Any]: merged copy.
    """
    merged = dict(base)
    for key, value in overlay.items():
        existing = merged.get(key)
        merged[key] = (
            deep_merge(existing, value) if isinstance(existing, dict) and isinstance(value, dict) else value
        )
    return merged


@dataclass
class Sandbox:
    """One isolated agent directory, HOME, cwd and process environment."""

    root: Path
    home: Path
    agent_dir: Path
    workdir: Path
    env_overrides: dict[str, str] = field(default_factory=dict)

    def env(self, extra: dict[str, str] | None = None, *, installing: bool = False) -> dict[str, str]:
        """Build a scrubbed environment; installers alone receive the real npm/git PATH.

        Parameters:
            extra (dict[str, str] | None): deliberate scenario additions.
            installing (bool): allow package manager executables, not policy shims.

        Returns:
            dict[str, str]: complete child environment with private writable state.
        """
        path = os.environ.get("PATH", os.defpath)
        return (
            BASE_ENV
            | {
                "PATH": path if installing else os.pathsep.join([str(self.shims_dir), path]),
                "HOME": str(self.home),
                "PI_CODING_AGENT_DIR": str(self.agent_dir),
                "TMPDIR": str(self.root / "tmp"),
                "TMP": str(self.root / "tmp"),
                "TEMP": str(self.root / "tmp"),
                "XDG_CONFIG_HOME": str(self.home / ".config"),
                "XDG_CACHE_HOME": str(self.home / ".cache"),
                "XDG_DATA_HOME": str(self.home / ".local/share"),
                "XDG_STATE_HOME": str(self.home / ".local/state"),
                "CODEX_HOME": str(self.home / ".codex"),
                "npm_config_cache": str(self.root / "npm-cache"),
                "npm_config_userconfig": str(self.root / "npmrc-user"),
                "npm_config_globalconfig": str(self.root / "npmrc-global"),
            }
            | self.env_overrides
            | (extra or {})
        )

    @property
    def shims_dir(self) -> Path:
        """Command shims prepended to scenario PATH."""
        return self.root / "shims"

    @property
    def settings_path(self) -> Path:
        """Sandbox settings file."""
        return self.agent_dir / "settings.json"

    def settings(self) -> dict[str, Any]:
        """Read only this sandbox's settings.

        Returns:
            dict[str, Any]: settings, empty when absent.
        """
        return json.loads(self.settings_path.read_text()) if self.settings_path.is_file() else {}

    def patch_json(self, name: str, overlay: dict[str, Any]) -> None:
        """Overlay one sandbox JSON document.

        Parameters:
            name (str): agent-relative file.
            overlay (dict[str, Any]): winning values.
        """
        path = self.agent_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        current = json.loads(path.read_text()) if path.is_file() else {}
        path.write_text(json.dumps(deep_merge(current, overlay), indent=2))


def build_sandbox(root: Path, template_home: Path | None = None) -> Sandbox:
    """Copy an explicit installed fixture tree, never machine state.

    Parameters:
        root (Path): new sandbox root.
        template_home (Path | None): installed throwaway HOME; absent builds a bare fixture.

    Returns:
        Sandbox: independent writable home and package copies.
    """
    home = root / "home"
    if template_home is not None:
        shutil.copytree(template_home, home, symlinks=False)
    agent_dir = home / ".pi" / "agent"
    agent_dir.mkdir(parents=True, exist_ok=True)
    workdir = root / "work"
    workdir.mkdir()
    (root / "tmp").mkdir()
    box = Sandbox(root, home, agent_dir, workdir)
    for name in ("npmrc-user", "npmrc-global"):
        (root / name).touch()
    box.patch_json(
        "settings.json", {"lastChangelogVersion": SILENT_CHANGELOG_VERSION, "retry": {"enabled": False}}
    )
    auth = agent_dir / "auth.json"
    auth.write_text(json.dumps(FAKE_AUTH))
    auth.chmod(0o600)
    box.patch_json("pi-session-kit.json", {"titles": {"enabled": False}})
    install_shims(box.shims_dir)
    return box


def install_stack(root: Path, stack_path: Path) -> Sandbox:
    """Install every supplied source through Pi, then apply explicit overlays and exclusions.

    Parameters:
        root (Path): new private install root.
        stack_path (Path): validated package-set input.

    Returns:
        Sandbox: installed fixture, suitable for copying to per-test homes.

    Raises:
        subprocess.CalledProcessError: an actual package install failed.
    """
    stack = load_stack(stack_path)
    sources = stack.resolved_sources(stack_path)
    box = build_sandbox(root)
    LOGGER.info(f"Stack '{stack.name}' sha256={stack_digest(stack_path)}")
    for source in sources:
        LOGGER.info(f"pi install '{source}'")
        try:
            subprocess.check_output(
                [*pi_command(), "install", source],
                cwd=box.workdir,
                env=box.env({"PI_OFFLINE": "0"}, installing=True),
                text=True,
                stderr=subprocess.STDOUT,
                timeout=600,
            )
        except subprocess.CalledProcessError as error:
            raise RuntimeError(f"`pi install` failed for '{source}': {error.output[-6000:]}") from error
    packages = box.settings().get("packages", [])
    identities = []
    for original, resolved in zip(stack.sources, sources, strict=True):
        directory = package_directory(resolved, box.agent_dir)
        manifest = json.loads((directory / "package.json").read_text())
        identities.append({"name": manifest["name"], "version": manifest["version"], "source": resolved})
        LOGGER.info(f"Installed {manifest['name']}@{manifest['version']} from '{resolved}'")
        if original in stack.disabled_extensions:
            LOGGER.warning(f"NOT LOADED '{resolved}': {stack.disabled_extensions[original]}")
            packages = [({"source": resolved, "extensions": []} if p == resolved else p) for p in packages]
    box.patch_json("settings.json", stack.settings | {"packages": packages})
    (box.agent_dir / "stack-name").write_text(stack.name)
    (box.agent_dir / "stack-evidence.json").write_text(
        json.dumps(
            {
                "stack": stack.name,
                "sha256": stack_digest(stack_path),
                "packages": identities,
                "disabled_extensions": stack.disabled_extensions,
            },
            indent=2,
        )
    )
    # Fixture policy, not rendered owner preferences. The real deferred engine consumes this file.
    box.patch_json(
        "deferred-tools.json",
        {
            "alwaysActive": [
                "read",
                "edit",
                "write",
                "bash",
                "grep",
                "find",
                "ls",
                "Agent",
                "todo",
                "git_status",
                "git_diff",
                "git_log",
                "git_show",
                "git_commit",
                "git_worktree_list",
                "ssh_exec",
                "monitor_read",
                "search_tools",
                "memory_read",
                "memory_write",
                "memory_search",
                "scratchpad",
                "web_search",
                "fetch_content",
                "source_check",
                "get_search_content",
                "get_subagent_result",
                "steer_subagent",
                "plan_mode_question",
                "plan_mode_complete",
            ],
        },
    )
    box.patch_json(
        "subscription-router.json",
        {"profiles": {"default": {"name": "Stack", "chain": [{"model": "anthropic/claude-haiku-4-5"}]}}},
    )
    workflows = box.home / ".pi" / "workflows" / "settings.json"
    workflows.parent.mkdir(parents=True, exist_ok=True)
    workflows.write_text('{"keywordTriggerEnabled":false}')
    return box


def package_name(source: str) -> str:
    """Return the short name of an explicit npm/git/path source.

    Parameters:
        source (str): package source.

    Returns:
        str: short name.
    """
    spec = source.removeprefix("npm:").removeprefix("git:").rstrip("/")
    last = spec.rsplit("/", 1)[-1]
    if "@" in last.lstrip("@"):
        spec = spec[: spec.rindex("@")]
    return spec.rsplit("/", 1)[-1].rsplit(":", 1)[-1].removesuffix(".git")


def install_shims(shims_dir: Path) -> None:
    """Write non-destructive policy stand-ins.

    Parameters:
        shims_dir (Path): private executable directory.
    """
    shims_dir.mkdir(parents=True, exist_ok=True)
    for name in SHIMMED_COMMANDS:
        shim = shims_dir / name
        shim.write_text(SHIM_SCRIPT)
        shim.chmod(0o755)


def enable_faux_models(box: Sandbox, models: list[str]) -> None:
    """Make declared faux child models eligible for scoped dispatch.

    Parameters:
        box (Sandbox): fixture to patch.
        models (list[str]): provider/model identities.
    """
    box.patch_json(
        "settings.json",
        {"enabledModels": list(dict.fromkeys([*box.settings().get("enabledModels", []), *models]))},
    )
