"""Helpers for static config checks: pi's settings keys, git pins, and the Brew pin chain.

References:
- pi `Settings` interface (<= 1.0): https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/core/settings-manager.ts
- pi `SettingsSchema` (>= 1.2): https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/settings-schema.ts
- Homebrew formula DSL `version`: https://docs.brew.sh/Formula-Cookbook
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from harness.paths import GIT_BIN, NODE_BIN

PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent"
SETTINGS_INTERFACE = re.compile(r"export interface Settings \{")
MEMBER_NAME = re.compile(r"^\s*(?:readonly\s+)?(?:[\"']([^\"']+)[\"']|([A-Za-z_$][\w$]*))\??\s*:")
GIT_PACKAGE = re.compile(r"^git:(?P<host>[^/]+)/(?P<owner>[^/]+)/(?P<repo>[^@]+)@(?P<ref>.+)$")
BREWFILE_PIN = re.compile(r"^#\s*pinned:\s*(?P<pin>\S+)\s*$", re.MULTILINE)
FORMULA_VERSION = re.compile(r'^\s*version\s+"(?P<version>[^"]+)"', re.MULTILINE)


def settings_keys(declaration: str) -> set[str]:
    """Extract the top-level member names of `interface Settings` from TypeScript source.

    Parameters:
        declaration (str): contents of `settings-manager.d.ts` or `.ts`.

    Returns:
        set[str]: top-level keys.

    Raises:
        ValueError: the interface is missing or unterminated.
    """
    match = SETTINGS_INTERFACE.search(declaration)
    if match is None:
        raise ValueError("No `export interface Settings {` in the declaration")
    depth = 1
    keys: set[str] = set()
    for line in declaration[match.end() :].splitlines():
        if depth == 1 and (member := MEMBER_NAME.match(line)):
            keys.add(member.group(1) or member.group(2))
        depth += line.count("{") - line.count("}")
        if depth <= 0:
            return keys
    raise ValueError("Unterminated `interface Settings`")


def pi_package_dir(argv: list[str]) -> Path:
    """Locate the `@earendil-works/pi-coding-agent` package behind a pi command.

    Handles the Homebrew wrapper (`bin/pi` -> `libexec/lib/node_modules/...`) and a direct
    `node .../dist/bundle/cli.js` command.

    Parameters:
        argv (list[str]): pi command prefix.

    Returns:
        Path: package root containing `package.json`.

    Raises:
        FileNotFoundError: no candidate package root was found.
    """
    for part in argv:
        path = Path(part).expanduser()
        if not path.exists():
            continue
        resolved = path.resolve()
        candidates = [
            resolved.parent.parent / "libexec" / "lib" / "node_modules" / PI_PACKAGE_NAME,
            *resolved.parents,
        ]
        for candidate in candidates:
            manifest = candidate / "package.json"
            if manifest.is_file() and json.loads(manifest.read_text()).get("name") == PI_PACKAGE_NAME:
                return candidate
    raise FileNotFoundError(f"Cannot locate `{PI_PACKAGE_NAME}` behind '{' '.join(argv)}'")


def schema_settings_keys(schema: Path) -> set[str]:
    """Read the top-level keys of pi's compiled `SettingsSchema` (pi 1.2 and later).

    pi 1.2 derives `Settings` from a typebox schema, so the keys are runtime data, not interface
    members. The compiled module is imported in a throwaway node process.

    Parameters:
        schema (Path): `dist/core/settings-schema.js` of the pi package.

    Returns:
        set[str]: top-level keys of `SettingsSchema.properties`.

    Raises:
        ValueError: node failed, or the module has no `SettingsSchema` object schema.
    """
    script = (
        "import(process.argv[1]).then((m) => console.log(JSON.stringify("
        "Object.keys(m.SettingsSchema?.properties ?? {}))))"
    )
    try:
        out = subprocess.check_output(
            [NODE_BIN, "-e", script, schema.as_uri()],
            text=True,
            stderr=subprocess.PIPE,
            timeout=30,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise ValueError(f"Could not load `SettingsSchema` from '{schema}': {exc}") from exc
    keys = set(json.loads(out))
    if not keys:
        raise ValueError(f"`SettingsSchema` in '{schema}' declares no properties")
    return keys


def pi_settings_keys(package_dir: Path) -> set[str]:
    """Return the settings keys the pi package declares.

    Parameters:
        package_dir (Path): pi package root.

    Returns:
        set[str]: top-level `Settings` keys.

    Raises:
        FileNotFoundError: no settings schema, `.d.ts`, or `.ts` source exists.
        ValueError: the schema or declaration could not be read.
    """
    schema = package_dir / "dist" / "core" / "settings-schema.js"
    if schema.is_file():
        return schema_settings_keys(schema)
    for relative in ("dist/core/settings-manager.d.ts", "src/core/settings-manager.ts"):
        path = package_dir / relative
        if path.is_file():
            return settings_keys(path.read_text())
    raise FileNotFoundError(f"No settings-manager declaration under '{package_dir}'")


@dataclass(frozen=True)
class GitPin:
    """A `git:` package source pinned to a ref.

    Attributes:
        source (str): full package source string.
        host (str): e.g. `github.com`.
        owner (str): repo owner.
        repo (str): repo name.
        ref (str): tag, branch, or commit.
    """

    source: str
    host: str
    owner: str
    repo: str
    ref: str


def git_pins(packages: list[object]) -> list[GitPin]:
    """Parse the pinned `git:` sources out of a settings `packages` list.

    Parameters:
        packages (list[object]): strings or `{source: ...}` objects.

    Returns:
        list[GitPin]: pinned git sources; unpinned and non-git entries are skipped.
    """
    pins = []
    for package in packages:
        source = package.get("source") if isinstance(package, dict) else package
        if not isinstance(source, str):
            continue
        if match := GIT_PACKAGE.match(source):
            pins.append(GitPin(source=source, **match.groupdict()))
    return pins


def checkout_matches_ref(checkout: Path, ref: str) -> tuple[bool, str]:
    """Report whether a checkout's HEAD is the commit `ref` names.

    Parameters:
        checkout (Path): git working tree.
        ref (str): tag, branch, or commit.

    Returns:
        tuple[bool, str]: match flag and a human-readable explanation.
    """

    def rev(spec: str) -> str | None:
        try:
            return subprocess.check_output(
                [GIT_BIN, "-C", str(checkout), "rev-parse", "--verify", "--quiet", spec],
                text=True,
                stderr=subprocess.DEVNULL,
            ).strip()
        except subprocess.CalledProcessError:
            return None

    head = rev("HEAD")
    wanted = rev(f"{ref}^{{commit}}") or remote_ref_commit(checkout, ref)
    if head is None:
        return False, f"'{checkout}' is not a git checkout"
    if wanted is None:
        return False, f"'{checkout}' has no ref '{ref}' (HEAD {head[:9]})"
    return head == wanted, f"HEAD {head[:9]} vs '{ref}' {wanted[:9]}"


def remote_ref_commit(checkout: Path, ref: str) -> str | None:
    """Resolve a tag or branch on `origin` when the checkout never fetched it.

    pi installs git packages without tags, so a pinned tag is usually only on the remote.

    Parameters:
        checkout (Path): git working tree with an `origin` remote.
        ref (str): tag or branch name.

    Returns:
        str | None: the commit the ref names (peeled for annotated tags), or None.
    """
    try:
        listed = subprocess.check_output(
            [
                GIT_BIN,
                "-C",
                str(checkout),
                "ls-remote",
                "origin",
                f"refs/tags/{ref}",
                f"refs/tags/{ref}^{{}}",
                f"refs/heads/{ref}",
            ],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None
    refs = {}
    for line in listed.splitlines():
        commit, _, name = line.partition("\t")
        refs[name] = commit
    return refs.get(f"refs/tags/{ref}^{{}}") or refs.get(f"refs/tags/{ref}") or refs.get(f"refs/heads/{ref}")


def brewfile_pin(brewfile: str) -> str:
    """Return the `# pinned: <tag>` comment value from a Brewfile.

    Parameters:
        brewfile (str): Brewfile text.

    Returns:
        str: pinned tag, e.g. `v1.0.0-nredd.1`.

    Raises:
        ValueError: there is not exactly one pin comment.
    """
    pins = BREWFILE_PIN.findall(brewfile)
    if len(pins) != 1:
        raise ValueError(f"Expected one `# pinned:` comment, found {len(pins)}")
    return pins[0]


def formula_version(formula: str) -> str:
    """Return the explicit `version "..."` of a Homebrew formula.

    Parameters:
        formula (str): formula Ruby source.

    Returns:
        str: declared version.

    Raises:
        ValueError: no explicit version line.
    """
    match = FORMULA_VERSION.search(formula)
    if match is None:
        raise ValueError("Formula has no explicit `version` line")
    return match.group("version")
