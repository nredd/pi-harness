"""Throwaway pi homes rendered from chezmoi, wired to the real installed extensions.

The rendered config is the chezmoi *target* state (what `chezmoi apply` would write), so the
harness verifies the config as committed, not whatever drifted onto disk. Installed extension
code is symlinked from the live agent dir; `auth.json` is never copied.

References:
- `chezmoi cat`: https://www.chezmoi.io/reference/commands/cat/
- `chezmoi managed`: https://www.chezmoi.io/reference/commands/managed/
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from harness.paths import CHEZMOI_BIN, HOME, LIVE_AGENT_DIR

LOGGER = logging.getLogger(__name__)

# Rendered files that would shadow a symlinked live directory, or are docs only.
SKIPPED_PREFIXES = (".pi/agent/npm/", ".pi/agent/git/")
SKIPPED_FILES = frozenset({".pi/agent/README.md"})
# Deterministic process environment for every pi launch.
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
    # pi-memory would otherwise fetch a 300 MB qmd embedding model into every fresh sandbox
    # `$HOME` and hold the process open ~35s at exit while it embeds.
    "PI_MEMORY_QMD_UPDATE": "off",
}
# Placeholder credentials so configured models resolve. Requests with them fail closed, and
# faux providers answer every scripted call; the real `auth.json` is never read.
FAKE_AUTH = {
    "anthropic": {"type": "api_key", "key": "harness-fake-key"},
    "openai-codex": {
        "type": "oauth",
        "access": "harness-fake-access",
        "refresh": "harness-fake-refresh",
        "expires": 4_102_444_800_000,
        "accountId": "harness",
    },
}
# Package names kept out of every sandbox, whatever the source form (npm, git fork, local path).
# `pi-computer-use` installs and launches its helper app under `$HOME/Applications`; a sandbox
# `$HOME` makes that a new app per test, macOS pops a permission window for each one, and the
# "helper did not start" warning lands in every TUI transcript.
SANDBOX_EXCLUDED_PACKAGES = ("pi-computer-use",)
# npm packages `HARNESS_LOCAL` may swap for a local checkout (git ones are matched by repo name).
NPM_LOCAL_OVERRIDES = ("pi-claude-auth",)
# Newer than any real release, so pi never shows "what's new" in a sandbox.
SILENT_CHANGELOG_VERSION = "999.0.0"
# Commands that reach the network, another host, or the system are shimmed in every sandbox,
# so a policy regression in a "must block" scenario cannot do real damage. Each shim prints
# `SHIM <name> <args>` and exits 0.
SHIMMED_COMMANDS = ("ssh", "scp", "rsync", "curl", "wget", "gh", "sudo", "brew", "chezmoi", "npm", "open")
SHIM_SCRIPT = '#!/bin/sh\necho "SHIM $(basename "$0") $*"\n'
# Variables passed through from the caller's environment.
PASSTHROUGH_ENV = ("PATH", "TMPDIR", "USER", "LOGNAME", "SHELL", "NODE_OPTIONS")


def render_chezmoi_pi_tree(destination: Path) -> list[Path]:
    """Render every chezmoi-managed file under `~/.pi` into `destination`.

    Parameters:
        destination (Path): directory standing in for `$HOME`.

    Returns:
        list[Path]: home-relative paths that were rendered.

    Raises:
        RuntimeError: chezmoi failed to list or render a file.
    """
    try:
        listed = subprocess.check_output(
            [CHEZMOI_BIN, "managed", "--include=files", "--path-style=relative", str(HOME / ".pi")],
            text=True,
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"`chezmoi managed` failed: {e.stderr.strip()}") from e
    rendered: list[Path] = []
    for line in listed.splitlines():
        relative = line.strip()
        if not relative or relative in SKIPPED_FILES or relative.startswith(SKIPPED_PREFIXES):
            continue
        try:
            content = subprocess.check_output(
                [CHEZMOI_BIN, "cat", str(HOME / relative)], stderr=subprocess.PIPE
            )
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"`chezmoi cat` failed for '{relative}': {e.stderr.decode().strip()}") from e
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        rendered.append(Path(relative))
    LOGGER.info(f"Rendered {len(rendered)} chezmoi-managed files under '{destination}'")
    return rendered


def deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Merge `overlay` into a copy of `base`, recursing into nested objects.

    Parameters:
        base (dict[str, Any]): original mapping.
        overlay (dict[str, Any]): values that win.

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
    """One isolated pi home.

    Attributes:
        root (Path): scratch root holding everything below.
        home (Path): stand-in `$HOME`.
        agent_dir (Path): `$HOME/.pi/agent`, exported as `PI_CODING_AGENT_DIR`.
        workdir (Path): cwd for pi runs.
        env_overrides (dict[str, str]): extra environment for every launch.
    """

    root: Path
    home: Path
    agent_dir: Path
    workdir: Path
    env_overrides: dict[str, str] = field(default_factory=dict)

    def env(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        """Build the process environment for a pi launch in this sandbox.

        Parameters:
            extra (dict[str, str] | None): per-launch additions.

        Returns:
            dict[str, str]: complete environment; nothing else leaks from the caller.
        """
        passthrough = {name: os.environ[name] for name in PASSTHROUGH_ENV if name in os.environ}
        passthrough["PATH"] = os.pathsep.join([str(self.shims_dir), passthrough.get("PATH", os.defpath)])
        return (
            passthrough
            | BASE_ENV
            | {"HOME": str(self.home), "PI_CODING_AGENT_DIR": str(self.agent_dir)}
            | self.env_overrides
            | (extra or {})
        )

    @property
    def shims_dir(self) -> Path:
        """Directory of command shims prepended to `PATH`."""
        return self.root / "shims"

    @property
    def settings_path(self) -> Path:
        """Path of the sandbox `settings.json`."""
        return self.agent_dir / "settings.json"

    def settings(self) -> dict[str, Any]:
        """Return the sandbox settings.

        Returns:
            dict[str, Any]: parsed `settings.json`, empty when absent.
        """
        if not self.settings_path.is_file():
            return {}
        return json.loads(self.settings_path.read_text())

    def patch_json(self, name: str, overlay: dict[str, Any]) -> None:
        """Deep-merge `overlay` into an agent-dir JSON file, creating it if needed.

        Parameters:
            name (str): file name relative to the agent dir, e.g. `settings.json`.
            overlay (dict[str, Any]): values that win.
        """
        path = self.agent_dir / name
        current = json.loads(path.read_text()) if path.is_file() else {}
        path.write_text(json.dumps(deep_merge(current, overlay), indent=2))


def link_installed_extensions(agent_dir: Path, local_overrides: dict[str, Path]) -> None:
    """Symlink the live `npm/` and per-repo `git/` checkouts into a sandbox agent dir.

    Parameters:
        agent_dir (Path): sandbox agent dir.
        local_overrides (dict[str, Path]): repo name -> local checkout used instead of the
            installed one, e.g. `{"pi-subagents": ~/code/pi-subagents}` to verify a fork
            before tagging it.

    Raises:
        FileNotFoundError: an override path does not exist.
    """
    live_npm = LIVE_AGENT_DIR / "npm"
    if live_npm.is_dir():
        (agent_dir / "npm").symlink_to(live_npm, target_is_directory=True)
    live_git = LIVE_AGENT_DIR / "git"
    if not live_git.is_dir():
        return
    for repo in sorted(live_git.glob("*/*/*")):
        relative = repo.relative_to(live_git)
        target = agent_dir / "git" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        source = local_overrides.get(repo.name, repo)
        if not source.exists():
            raise FileNotFoundError(f"Local override for `{repo.name}` does not exist: '{source}'")
        target.symlink_to(source, target_is_directory=True)


def local_overrides_from_env() -> dict[str, Path]:
    """Parse `HARNESS_LOCAL`, a comma list of `name` or `name=path` checkouts to test.

    A bare `name` means `~/code/<name>`.

    Returns:
        dict[str, Path]: repo name -> checkout path.
    """
    overrides: dict[str, Path] = {}
    for item in filter(None, (part.strip() for part in os.environ.get("HARNESS_LOCAL", "").split(","))):
        name, _, raw_path = item.partition("=")
        overrides[name] = Path(raw_path or HOME / "code" / name).expanduser().resolve()
    return overrides


def build_sandbox(root: Path, template_home: Path, local_overrides: dict[str, Path] | None = None) -> Sandbox:
    """Create a sandbox from a pre-rendered chezmoi home.

    Parameters:
        root (Path): empty scratch directory.
        template_home (Path): output of `render_chezmoi_pi_tree`, copied per sandbox.
        local_overrides (dict[str, Path] | None): see `link_installed_extensions`.

    Returns:
        Sandbox: ready-to-launch sandbox.
    """
    home = root / "home"
    shutil.copytree(template_home, home, symlinks=True)
    agent_dir = home / ".pi" / "agent"
    agent_dir.mkdir(parents=True, exist_ok=True)
    link_installed_extensions(agent_dir, local_overrides or {})
    # Preserve public cached helpers in offline mode, without sharing a writable
    # live bin directory or depending on subprocess-based PATH discovery.
    for name in ("fd", "rg", "fd.exe", "rg.exe"):
        helper = LIVE_AGENT_DIR / "bin" / name
        if helper.is_file():
            destination = agent_dir / "bin" / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(helper, destination)
    # Offline sandboxes need the same public model metadata as the installed harness.
    # Copy, never symlink: a sandbox must not refresh or mutate the live catalogue.
    catalogue = LIVE_AGENT_DIR / "models-store.json"
    if catalogue.is_file():
        shutil.copyfile(catalogue, agent_dir / catalogue.name)
    # The live `lastChangelogVersion` rides along in the render; a stale one makes pi print its
    # whole changelog over the first frame. Scenarios want a quiet start.
    settings_path = agent_dir / "settings.json"
    if settings_path.is_file():
        settings = json.loads(settings_path.read_text())
        settings["lastChangelogVersion"] = SILENT_CHANGELOG_VERSION
        settings["packages"] = with_local_npm_packages(
            without_excluded_packages(settings.get("packages", [])), local_overrides or {}
        )
        # A faux error must fail once, not back off and replay; retries make timing nondeterministic.
        settings["retry"] = {"enabled": False}
        settings_path.write_text(json.dumps(settings, indent=2))
    auth_path = agent_dir / "auth.json"
    auth_path.write_text(json.dumps(FAKE_AUTH, indent=2))
    auth_path.chmod(0o600)
    workdir = root / "work"
    workdir.mkdir()
    box = Sandbox(root=root, home=home, agent_dir=agent_dir, workdir=workdir)
    # Auto-titles default to a real provider even in otherwise faux TUI runs.
    # Explicit title scenarios opt back in with a faux model after sandbox creation.
    box.patch_json("pi-session-kit.json", {"titles": {"enabled": False}})
    # MCP servers stay registered but disabled: the configured `rea` server is an `npx` download
    # and a 207-tool stdio process, neither of which a faux sandbox may spawn or wait for.
    if (agent_dir / "mcp.json").is_file():
        servers = json.loads((agent_dir / "mcp.json").read_text()).get("mcpServers", {})
        box.patch_json("mcp.json", {"mcpServers": {name: {"enabled": False} for name in servers}})
    install_shims(box.shims_dir)
    return box


def package_name(source: str) -> str:
    """Name of the package a settings source installs, for npm, git, URL, and path sources.

    Parameters:
        source (str): e.g. `npm:@scope/name@1.0`, `git:github.com/owner/name@v1`,
            `https://github.com/owner/name.git`, `~/code/name`.

    Returns:
        str: the bare package or repo name (`name` for all of the above).
    """
    spec = source.removeprefix("npm:").removeprefix("git:").rstrip("/")
    last = spec.rsplit("/", 1)[-1]
    if "@" in last.lstrip("@"):
        spec = spec[: spec.rindex("@")]
    return spec.rsplit("/", 1)[-1].rsplit(":", 1)[-1].removesuffix(".git")


def without_excluded_packages(packages: list[Any]) -> list[Any]:
    """Drop packages named in `SANDBOX_EXCLUDED_PACKAGES` from a settings `packages` list.

    Parameters:
        packages (list[Any]): source strings or `{source: ...}` objects.

    Returns:
        list[Any]: the list without excluded packages, order kept.
    """

    def source(package: Any) -> str:
        return str(package.get("source", "")) if isinstance(package, dict) else str(package)

    return [package for package in packages if package_name(source(package)) not in SANDBOX_EXCLUDED_PACKAGES]


def with_local_npm_packages(packages: list[Any], local_overrides: dict[str, Path]) -> list[Any]:
    """Point `npm:<name>` sources at a `HARNESS_LOCAL` checkout, in the sandbox settings only.

    Only the npm packages in `NPM_LOCAL_OVERRIDES` are eligible, so `HARNESS_LOCAL=pi-claude-auth`
    swaps the sandbox's `npm:pi-claude-auth[@version]` entry for the checkout path and leaves the
    live `~/.pi/agent/npm` tree alone. Other entries, and git overrides, are untouched.

    Parameters:
        packages (list[Any]): source strings or `{source: ...}` objects.
        local_overrides (dict[str, Path]): `HARNESS_LOCAL` name -> checkout.

    Returns:
        list[Any]: the list with eligible sources replaced by the checkout path, order kept.

    Raises:
        FileNotFoundError: an eligible override path does not exist.
    """
    wanted = {name: local_overrides[name] for name in NPM_LOCAL_OVERRIDES if name in local_overrides}
    for name, path in wanted.items():
        if not path.exists():
            raise FileNotFoundError(f"Local override for `{name}` does not exist: '{path}'")

    def replaced(package: Any) -> Any:
        source = str(package.get("source", "")) if isinstance(package, dict) else str(package)
        if not source.startswith("npm:"):
            return package
        name = source.removeprefix("npm:").rpartition("@")[0] or source.removeprefix("npm:")
        if name not in wanted:
            return package
        return package | {"source": str(wanted[name])} if isinstance(package, dict) else str(wanted[name])

    return [replaced(package) for package in packages]


def install_shims(shims_dir: Path) -> None:
    """Write the `SHIMMED_COMMANDS` stand-ins.

    Parameters:
        shims_dir (Path): directory to create.
    """
    shims_dir.mkdir(parents=True, exist_ok=True)
    for name in SHIMMED_COMMANDS:
        shim = shims_dir / name
        shim.write_text(SHIM_SCRIPT)
        shim.chmod(0o755)


def enable_faux_models(box: Sandbox, models: list[str]) -> None:
    """Append faux `provider/id` entries to the sandbox `enabledModels`.

    Subagents with `scopeModels` only run on enabled models, so faux children need this.

    Parameters:
        box (Sandbox): sandbox to patch.
        models (list[str]): `provider/id` entries.
    """
    settings = box.settings()
    enabled = list(dict.fromkeys([*settings.get("enabledModels", []), *models]))
    box.patch_json("settings.json", {"enabledModels": enabled})
