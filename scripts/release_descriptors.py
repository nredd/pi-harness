"""Declarative release targets for the trusted npm publisher.

A descriptor is the only package-specific input to ``npm_release.py``. Adding a
package must add its source, test, packed-artifact and contract requirements here
rather than adding a name branch to the publisher.

References:
    https://docs.npmjs.com/cli/v11/commands/npm-pack
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal

import package_contracts as pc


@dataclass(frozen=True)
class ReleaseDescriptor:
    """Package-specific inputs consumed by the generic release stages.

    Parameters:
        name (str): Public npm package name.
        workspace (PurePosixPath): Package source directory relative to the repository root.
        verify_commands (tuple[tuple[str, ...], ...]): Checked commands, expressed without a shell.
        contract (pc.PackageContract): Packed-artifact contract exercised after packing.
        contract_gates (tuple[Literal["stock", "fork"], ...]): Contract gates consuming the tarball.
        stock_gate (Callable[[pc.Context], pc.ScenarioEvidence] | None): Executable stock-Pi gate.
        native_artifacts (tuple[PurePosixPath, ...]): Required package-relative
            ``PurePosixPath.full_match`` glob patterns that must exist before packing and appear in the
            accepted tarball. ``*`` and ``?`` remain within one segment; ``**`` spans zero or more.
    """

    name: str
    workspace: PurePosixPath
    verify_commands: tuple[tuple[str, ...], ...]
    contract: pc.PackageContract
    contract_gates: tuple[Literal["stock", "fork"], ...]
    stock_gate: Callable[[pc.Context], pc.ScenarioEvidence] | None = None
    native_artifacts: tuple[PurePosixPath, ...] = ()


# These entries deliberately preserve the existing commands, paths and contract
# gates byte-for-byte. New packages add a descriptor, never a publisher branch.
DESCRIPTORS = (
    ReleaseDescriptor(
        name="@nredd/pi-computer-use",
        workspace=PurePosixPath("packages/computer-use"),
        verify_commands=(
            ("npm", "ci", "--ignore-scripts"),
            ("npm", "run", "check", "--workspace", "@nredd/pi-computer-use"),
        ),
        contract=pc.COMPUTER_USE_CONTRACT,
        contract_gates=("stock",),
        stock_gate=pc.scenario_computer_use,
        native_artifacts=(
            PurePosixPath("prebuilt/macos/arm64/bridge"),
            PurePosixPath("prebuilt/macos/x64/bridge"),
        ),
    ),
    ReleaseDescriptor(
        name="@nredd/pi-dev-tools",
        workspace=PurePosixPath("packages/dev-tools"),
        verify_commands=(
            ("npm", "ci", "--ignore-scripts"),
            ("npm", "run", "check", "--workspace", "@nredd/pi-dev-tools"),
        ),
        contract=pc.CONTRACTS[0],
        contract_gates=("stock", "fork"),
        stock_gate=pc.SCENARIOS["dev-tools"],
    ),
    ReleaseDescriptor(
        name="@nredd/pi-session-kit",
        workspace=PurePosixPath("packages/session-kit"),
        verify_commands=(
            ("npm", "ci", "--ignore-scripts"),
            ("npm", "run", "check", "--workspace", "@nredd/pi-session-kit"),
        ),
        contract=pc.CONTRACTS[1],
        contract_gates=("stock",),
        stock_gate=pc.SCENARIOS["session-kit"],
    ),
    ReleaseDescriptor(
        name="@nredd/pi-subscription-router",
        workspace=PurePosixPath("packages/subscription-router"),
        verify_commands=(
            ("npm", "ci", "--ignore-scripts"),
            ("npm", "run", "check", "--workspace", "@nredd/pi-subscription-router"),
        ),
        contract=pc.CONTRACTS[2],
        contract_gates=("stock",),
        stock_gate=pc.SCENARIOS["subscription-router"],
    ),
    ReleaseDescriptor(
        name="@nredd/pi-subagents",
        workspace=PurePosixPath("packages/subagents"),
        verify_commands=(
            ("npm", "ci", "--ignore-scripts"),
            ("npm", "run", "check", "--workspace", "@nredd/pi-subagents"),
        ),
        contract=pc.SUBAGENTS_CONTRACT,
        contract_gates=("stock",),
        stock_gate=pc.scenario_subagents,
    ),
    ReleaseDescriptor(
        name="@nredd/pi-plan-mode",
        workspace=PurePosixPath("packages/plan-mode"),
        verify_commands=(
            ("npm", "ci", "--ignore-scripts"),
            ("npm", "run", "check", "--workspace", "@nredd/pi-plan-mode"),
        ),
        contract=pc.PLAN_MODE_CONTRACT,
        contract_gates=("stock",),
        stock_gate=pc.scenario_plan_mode,
    ),
    ReleaseDescriptor(
        name="@nredd/pi-todo",
        workspace=PurePosixPath("packages/todo"),
        verify_commands=(
            ("npm", "ci", "--ignore-scripts"),
            ("npm", "run", "check", "--workspace", "@nredd/pi-todo"),
        ),
        contract=pc.TODO_CONTRACT,
        contract_gates=("stock",),
        stock_gate=pc.scenario_todo,
    ),
    ReleaseDescriptor(
        name="@nredd/pi-preset",
        workspace=PurePosixPath("packages/preset"),
        verify_commands=(
            ("npm", "ci", "--ignore-scripts"),
            ("npm", "run", "check", "--workspace", "@nredd/pi-preset"),
        ),
        contract=pc.PRESET_CONTRACT,
        contract_gates=("fork",),
    ),
)


def resolve_workspace(repo: Path, descriptor: ReleaseDescriptor) -> Path:
    """Return a descriptor workspace only when it remains inside ``repo``.

    Parameters:
        repo (Path): Repository root.
        descriptor (ReleaseDescriptor): Data-only release target.

    Returns:
        Path: Resolved package workspace.

    Raises:
        ValueError: If the descriptor escapes the repository or is malformed.
    """
    if descriptor.workspace.is_absolute() or any(
        part in {"", ".", ".."} for part in descriptor.workspace.parts
    ):
        raise ValueError(f"Release descriptor has unsafe workspace: '{descriptor.workspace}'")
    root = repo.resolve()
    workspace = (root / descriptor.workspace).resolve()
    if not workspace.is_relative_to(root):
        raise ValueError(f"Release descriptor workspace escapes repository: '{descriptor.workspace}'")
    return workspace


def descriptor_for(name: str) -> ReleaseDescriptor | None:
    """Find one public release descriptor by npm name.

    Parameters:
        name (str): Public npm package name.

    Returns:
        ReleaseDescriptor | None: The one registered descriptor, if any.
    """
    matches = [descriptor for descriptor in DESCRIPTORS if descriptor.name == name]
    if len(matches) != 1:
        return None
    return matches[0]
