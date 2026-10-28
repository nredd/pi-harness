"""Packed-package independence gate for the `@nredd/pi-*` plugins against exact stock Pi.

For each package this builds the real npm tarball, audits its contents, installs it alone into a
fresh project, and drives it through a real, exact-version stock Pi install:

1. `npm pack`: file list must match a narrow allowlist; `LICENSE` must be byte-identical to the
   repository root; the packed manifest must be public-publishable, keep host modules as `*` peers,
   and declare exactly the contract's runtime dependencies (none for most plugins).
2. Source audit: every import in the tarball is relative (inside the package), a Node builtin, a
   host-provided Pi module or a declared runtime dependency. No sibling plugin (only a published
   `SHARED_LIBRARIES` entry declared at its common exact pin), no bundled host copy. Imports
   come from the installed TypeScript parser (`import_audit.ts`, one batched `node` run per
   package) rather than a regex; computed specifiers are rejected, not skipped. It is a syntactic
   audit, not a proof about `eval`.
3. Fresh install (`--ignore-scripts --legacy-peer-deps`, like Pi's managed installs that suppress
   peer installation; `--offline` unless the contract declares registry runtime dependencies):
   `node_modules` holds only the package and its declared closure, never a host duplicate.
4. Stock Pi `--mode json` with only that package loaded (`--no-extensions --extension DIR`), a
   scrubbed environment, a temporary `HOME` and agent directory, no credentials, and a loopback
   scripted provider. The package must do real work: a dev tool result, a session-kit monitor and
   its stats artifact over a real session, and a router virtual model dispatching to a physical one.

Nothing here publishes anything or touches real Pi state. The stock Pi version and tarball
identities are recorded in the JSON report, which is a validated Pydantic model (`ContractReport`)
before it is serialized; nothing resolves "latest" at run time.

References:
    https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
    https://docs.npmjs.com/cli/v11/commands/npm-pack
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import os
import re
import secrets
import selectors
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
from collections import Counter
from collections.abc import Callable, Collection, Iterator, Mapping, Sequence
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field, replace
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Annotated, Any, Literal, Self, TypedDict
from urllib.parse import urlsplit

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    TypeAdapter,
    ValidationError,
    model_validator,
)

from faux_provider import (
    ErrorStep,
    FauxProvider,
    RecordedRequest,
    Route,
    Step,
    TextStep,
    ToolStep,
    models_json,
)

LOGGER = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_STOCK_PREFIX = Path.home() / "code" / "pi-harness-builds" / "tools" / "pi-stock-1.3.0"

STOCK_PI_PACKAGE = "@earendil-works/pi-coding-agent"
STOCK_PI_VERSION = "1.3.0"
STOCK_PI_INTEGRITY = (
    "sha512-V/WoCjA2hQSe3QLWIUB24cTRdtEdeLiIzkDqU5RMXV6VWuD+KGZnzVBMhglwdnQTySkehZsjt8a3g6Jd2g4nnw=="
)

# Modules Pi supplies to extensions; they must be peers and never bundled or depended on.
HOST_MODULES = (
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
)
SIBLING_SCOPE = "@nredd/"
PROVIDER = "local"  # Not `faux`: stats deliberately drop that provider name.
PHYSICAL_MODEL = "m"
PI_TIMEOUT_S = 120
NPM_TIMEOUT_S = 300
CODE_SUFFIXES = (".ts", ".mts", ".js", ".mjs")
NO_PROXY_VALUE = "127.0.0.1,localhost"
# Defense in depth for clients honoring proxy variables; this is not a network sandbox.
DEAD_PROXY = "http://127.0.0.1:9"
# Overrides that let one npm invocation reach the registry; every other install stays offline or dead-proxied.
SUBAGENTS_CHILD_MARKER = "pi-harness-subagents-child"
SUBAGENTS_CHILD_TEXT = "subagents child ok"
REGISTRY_ENV = {"HTTP_PROXY": "", "HTTPS_PROXY": ""}

IMPORT_AUDIT = Path(__file__).with_name("import_audit.ts")
IMPORT_AUDIT_TIMEOUT_S = 120
STATS_ARTIFACT = "dist/pi-stats-export.mjs"
STATS_PRIVATE_SENTINEL = "STATS-PRIVATE-TEXT-DO-NOT-EXPORT"
IMPORT_AUDIT_DIR = "pkg"  # Sources are laid out under this directory so the tsconfig cannot collide.


class ContractError(RuntimeError):
    """A package contract was violated, or the harness could not establish it."""


@dataclass(frozen=True)
class PackageContract:
    """Packaging expectations for one workspace package.

    Parameters:
        name (str): npm package name.
        directory (str): Directory under `packages/`.
        required (tuple[str, ...]): Files that must be in the tarball.
        allowed (tuple[re.Pattern[str], ...]): Every tarball path must match one of these.
        exposes_tools (frozenset[str]): Tool names unique to this package.
        license (str): Exact SPDX expression the packed manifest must declare.
        runtime_dependencies (tuple[tuple[str, str], ...]): The EXACT `dependencies` the packed manifest
            must declare, as (name, range) pairs (tuples keep the contract hashable). Empty for plugins,
            which depend on nothing but host modules; a package that genuinely needs a library must list
            it here, never have it accepted silently.
        peer_ranges (tuple[tuple[str, str], ...]): (name, range) peer ranges that deliberately differ from
            the default `*`.
        own_license (bool): The package retains an upstream copyright notice, so its packed `LICENSE`
            must equal the workspace's own `LICENSE` instead of the repository root one.
        standalone_artifacts (frozenset[str]): Files that must import only Node builtins when packed.
        packed_files (tuple[str, ...]): Exact packed paths, when the package has a fixed public payload.
        library (bool): Compiled ESM library, with no Pi entrypoint or host dependency permissions.
        node_probe (str): Fixed ESM consumer program executed against the isolated installed tarball.
        packed_patterns (tuple[tuple[re.Pattern[str], int], ...]): (pattern, exact count) pairs for packed
            paths with build-hashed names; together with `packed_files` they must cover the tarball exactly.
    """

    name: str
    directory: str
    required: tuple[str, ...]
    allowed: tuple[re.Pattern[str], ...]
    exposes_tools: frozenset[str]
    license: str = "MIT"
    runtime_dependencies: tuple[tuple[str, str], ...] = ()
    peer_ranges: tuple[tuple[str, str], ...] = ()
    own_license: bool = False
    library: bool = False
    node_probe: str = ""
    standalone_artifacts: frozenset[str] = frozenset()
    packed_files: tuple[str, ...] = ()
    packed_patterns: tuple[tuple[re.Pattern[str], int], ...] = ()


RESOURCE_SAMPLER_FILES = (
    "LICENSE",
    "README.md",
    "package.json",
    *(
        f"dist/{module}.{suffix}"
        for module in ("index", "types", "counters", "collect", "darwin")
        for suffix in ("js", "d.ts")
    ),
)
# Exact published release consumers install from the registry; never a range, workspace or file spec.
RESOURCE_SAMPLER_VERSION = "0.1.1"
# The hostile child puts a random secret in argv[0], its process title and (Linux) comm.
SAMPLER_HOSTILE_CHILD = """process.title = process.env.S;
if (process.platform === 'linux') require('node:fs').writeFileSync('/proc/self/comm', process.env.S);
console.log('ready'); setInterval(() => {}, 1000);"""
# Every process the library can bound, so a busy host fails with explicit coverage, never a silent pass.
SAMPLER_PROBE_BOUNDS = {"maxDurationMs": 5000, "maxPids": 16384, "maxBytes": 16_777_216}
SAMPLER_PROBE_BODY = """
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
const STOP_MS = 2000;
/**
 * @param {import('node:child_process').ChildProcess} child Owned child handle.
 * @returns {boolean} Whether this exact child's wait status is known.
 */
const exited = child => child.exitCode !== null || child.signalCode !== null;
/**
 * Wait for this exact child's exit status, never a reusable PID probe.
 * @param {import('node:child_process').ChildProcess} child Owned child handle.
 * @param {number} ms Maximum wait in milliseconds.
 * @returns {Promise<boolean>} Whether the runtime reaped the child within the bound.
 */
async function exitedWithin(child, ms) {
    if (exited(child)) return true;
    const timer = new AbortController();
    try {
        const exit = once(child, 'exit').then(() => true);
        return await Promise.race([exit, delay(ms, false, {signal: timer.signal})]);
    } finally { timer.abort(); }
}
/**
 * Terminate/reap with SIGTERM then SIGKILL, like integration/inprocess/support.ts.
 * @param {import('node:child_process').ChildProcess} child Owned child handle.
 * @returns {Promise<void>} Cleanup completion; rejects if the child survives SIGKILL.
 */
async function stop(child) {
    if (child.pid === undefined || exited(child)) return;
    child.kill('SIGTERM');
    if (await exitedWithin(child, STOP_MS)) return;
    child.kill('SIGKILL');
    if (!(await exitedWithin(child, STOP_MS))) throw new Error(`hostile child ${child.pid} survived SIGKILL`);
}
/**
 * @param {import('node:child_process').ChildProcess} child Child with piped stdout.
 * @param {number} ms Readiness bound in milliseconds.
 * @returns {Promise<void>} Ready-line completion; rejects on exit/error/timeout.
 */
function ready(child, ms) {
    return new Promise((resolve, reject) => {
        let output = '';
        /**
         * @param {Error | undefined} error Optional readiness failure.
         * @returns {void} Settle readiness and detach listeners/timer.
         */
        const finish = error => {
            clearTimeout(timer);
            child.stdout.off('data', data);
            child.off('exit', exit);
            child.off('error', finish);
            if (error) reject(error); else resolve();
        };
        /**
         * @param {Buffer} chunk Stdout readiness bytes.
         * @returns {void} Accumulate output and settle on the ready line.
         */
        const data = chunk => { output += chunk; if (output.includes('ready\\n')) finish(); };
        /** @returns {void} Reject readiness after early child exit. */
        const exit = () => finish(new Error('hostile child exited before readiness'));
        const timer = setTimeout(() => finish(new Error(`hostile child not ready within ${ms} ms`)), ms);
        child.stdout.on('data', data);
        child.once('exit', exit);
        child.once('error', finish);
    });
}
/**
 * @param {unknown} error Caught failure value.
 * @returns {string} Readable failure description.
 */
const message = error => (error instanceof Error ? error.message : String(error));
/**
 * Run the check then always reap; preserve both primary and cleanup failures.
 * @param {import('node:child_process').ChildProcess} child Owned child handle.
 * @param {() => Promise<void>} body Check to run after spawn.
 * @returns {Promise<void>} Check/cleanup completion, rejecting with preserved errors.
 */
async function supervise(child, body) {
    let failure;
    try { await body(); } catch (error) { failure = {error}; }
    try { await stop(child); } catch (cleanup) {
        if (!failure) throw cleanup;
        const text = `${message(failure.error)}; cleanup also failed: ${message(cleanup)}`;
        throw new AggregateError([failure.error, cleanup], text);
    } finally {
        const status = child.signalCode ?? child.exitCode;
        const pid = child.pid ?? 'never spawned';
        console.error(exited(child) ? `hostile child reaped: ${status}` : `hostile child ${pid} not reaped`);
    }
    if (failure) throw failure.error;
}
const secret = randomBytes(16).toString('hex');
const hostile = spawn(process.execPath, ['-e', CHILD_SCRIPT], {
    argv0: DISGUISE ? secret : process.execPath, env: {S: secret}, stdio: ['ignore', 'pipe', 'ignore'],
});
// Everything after spawn runs inside `supervise`, so readiness or negative-control failures still reap it.
await supervise(hostile, async () => {
    await ready(hostile, READY_MS);
    // Negative control: the 0.1.0 name source (Darwin `ps -c` comm, Linux comm) really carries the secret.
    const legacy = process.platform === 'linux'
        ? readFileSync(`/proc/${hostile.pid}/comm`, 'utf8').trim() === secret.slice(0, 15)
        : execFileSync('/bin/ps', ['-c', '-o', 'comm=', '-p', `${hostile.pid}`], {timeout: STOP_MS})
            .toString().includes(secret);
    assert.ok(legacy, 'hostile child does not expose the secret through the 0.1.0 name source');
    const { createResourceSampler } = await import('@nredd/pi-resource-sampler');
    const sampler = createResourceSampler(BOUNDS);
    try {
        const first = await sampler.sample();
        assert.equal(first.cpu.state, 'warming');
        await delay(60);
        const second = await sampler.sample();
        assert.equal(second.cpu.state, 'available');
        assert.ok(second.cpu.value >= 0 && second.cpu.value <= 100);
        if (process.platform === 'darwin') {
            assert.equal(second.memory.usage?.state, 'available', 'native memory usage missing');
            assert.equal(second.memory.usage.value.basis, 'app+wired+compressed');
            const { usedBytes, availableBytes } = second.memory.usage.value;
            assert.ok(usedBytes >= 0 && usedBytes <= second.memory.totalBytes);
            assert.equal(usedBytes + availableBytes, second.memory.totalBytes);
            assert.equal(second.memory.swap?.state, 'available', 'native swap missing');
            assert.ok(second.memory.swap.value.usedBytes <= second.memory.swap.value.totalBytes);
            const own = second.processes.find(p => p.pid === process.pid);
            const [major, minor] = process.versions.node.split('.').map(Number);
            if (major > 26 || (major === 26 && minor >= 1)) {
                assert.equal(own?.cpu.state, 'available', 'native interval CPU missing');
                assert.ok(own.cpu.value >= 0);
                assert.equal(own.footprint?.state, 'available', 'native footprint missing');
                assert.ok(own.footprint.value > 0);
            } else {
                assert.equal(own?.cpu.state, 'unavailable');
            }
        } else if (process.platform === 'linux') {
            assert.equal(second.memory.usage, undefined);
            assert.equal(second.memory.swap, undefined);
        }
        const coverage = JSON.stringify(second.coverage);
        /**
         * @param {number} pid Expected process identifier.
         * @returns {boolean} Whether the bounded sample contains the required process.
         */
        const seen = pid => second.processes.some(p => p.pid === pid);
        assert.ok(seen(process.pid), `probe not observed within bounds: ${coverage}`);
        assert.ok(seen(hostile.pid), `hostile child not observed within bounds: ${coverage}`);
        // Every 12-char window: shorter than Linux comm (15 bytes) and Darwin p_comm (16 bytes) fragments.
        const text = JSON.stringify([first, second]);
        for (let i = 0; i + 12 <= secret.length; i++)
            assert.ok(!text.includes(secret.slice(i, i + 12)), 'process names expose argv, title or comm');
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(sampler.sample(controller.signal));
    } finally { await sampler.dispose(); }
    await assert.rejects(sampler.sample(), /disposed/);
});
"""


def resource_sampler_probe(
    child_script: str = SAMPLER_HOSTILE_CHILD, *, disguise: bool = True, ready_ms: int = 5000
) -> str:
    """Build the installed-library probe around one disposable child.

    The defaults are the shipped contract. Tests inject a silent, an exiting, an undisguised and a
    SIGTERM-ignoring child to prove readiness and negative-control failures still reap it.

    Parameters:
        child_script (str): Node program the child evaluates; it prints `ready` once observable.
        disguise (bool): Whether the child's argv[0] is the secret rather than the Node executable.
        ready_ms (int): Readiness bound in milliseconds.

    Returns:
        str: ESM program for `node --input-type=module -e`.

    Raises:
        ValueError: If `ready_ms` is not positive.
    """
    if ready_ms <= 0:
        raise ValueError(f"`ready_ms` must be positive: '{ready_ms}'")
    config = (
        f"const CHILD_SCRIPT = {json.dumps(child_script)};\n"
        f"const DISGUISE = {json.dumps(disguise)};\n"
        f"const READY_MS = {ready_ms};\n"
        f"const BOUNDS = {json.dumps(SAMPLER_PROBE_BOUNDS)};\n"
    )
    return config + SAMPLER_PROBE_BODY


RESOURCE_SAMPLER_CONTRACT = PackageContract(
    name="@nredd/pi-resource-sampler",
    directory="resource-sampler",
    required=RESOURCE_SAMPLER_FILES,
    allowed=(re.compile(r"^(LICENSE|README\.md|package\.json)$"), re.compile(r"^dist/[a-z]+\.(js|d\.ts)$")),
    exposes_tools=frozenset(),
    packed_files=RESOURCE_SAMPLER_FILES,
    library=True,
    node_probe=resource_sampler_probe(),
)

# Compiled, Pi-independent `@nredd/` libraries a plugin may import, mapped to the ONE exact registry
# release every consumer must declare (`shared_library_pin_problems`). The single definition for both
# sampler consumers (dev-tools `resource_snapshot`, session-kit `/mon`); `classify_imports` still refuses
# it in library and standalone-artifact files. Plugins remain banned from importing each other.
SHARED_LIBRARIES: Mapping[str, str] = MappingProxyType(
    {RESOURCE_SAMPLER_CONTRACT.name: RESOURCE_SAMPLER_VERSION}
)


CONTRACTS = (
    PackageContract(
        name="@nredd/pi-dev-tools",
        directory="dev-tools",
        required=("LICENSE", "README.md", "package.json", "src/index.ts"),
        allowed=(re.compile(r"^(LICENSE|README\.md|package\.json)$"), re.compile(r"^src/.+\.ts$")),
        exposes_tools=frozenset({"git_status", "resource_snapshot"}),
        runtime_dependencies=((RESOURCE_SAMPLER_CONTRACT.name, RESOURCE_SAMPLER_VERSION),),
    ),
    PackageContract(
        name="@nredd/pi-session-kit",
        directory="session-kit",
        # The README links both docs, so a tarball without them would ship dead links.
        required=(
            "LICENSE",
            "README.md",
            "package.json",
            "src/index.ts",
            "dist/pi-stats-export.mjs",
            "docs/stats-snapshots.md",
            "docs/mon-dashboard.md",
        ),
        allowed=(
            re.compile(r"^(LICENSE|README\.md|CHANGELOG\.md|package\.json)$"),
            re.compile(r"^src/.+\.(ts|md)$"),
            re.compile(r"^dist/pi-stats-export\.mjs$"),
            re.compile(r"^docs/(stats-snapshots|mon-dashboard)\.md$"),
        ),
        exposes_tools=frozenset({"monitor_start", "monitor_read", "monitor_stop"}),
        runtime_dependencies=((RESOURCE_SAMPLER_CONTRACT.name, RESOURCE_SAMPLER_VERSION),),
        standalone_artifacts=frozenset({STATS_ARTIFACT}),
    ),
    PackageContract(
        name="@nredd/pi-subscription-router",
        directory="subscription-router",
        required=("LICENSE", "README.md", "package.json", "src/index.ts"),
        allowed=(
            re.compile(r"^(LICENSE|README\.md|CHANGELOG\.md|package\.json)$"),
            re.compile(r"^src/.+\.ts$"),
        ),
        exposes_tools=frozenset({"subscription_usage"}),
    ),
)

# The preset is audited and packed like the plugins but is deliberately NOT in `CONTRACTS`: it is not
# a standalone plugin (it relies on `packages/subagents` and `@nredd/pi-dev-tools` for its agents),
# so the stock gate does not run it; `run_audit_gate` audits and installs it alone instead. Its
# themes are separately licensed, so the manifest must declare the full expression, and the license
# texts plus `NOTICE.md` are required content rather than optional extras.
PRESET_CONTRACT = PackageContract(
    name="@nredd/pi-preset",
    directory="preset",
    required=(
        "LICENSE",
        "NOTICE.md",
        "README.md",
        "package.json",
        "agents/code-reviewer.md",
        "extensions/expanded-footer.ts",
        "licenses/Apache-2.0-tokyonight.nvim.txt",
        "licenses/CC-BY-SA-4.0.txt",
        "licenses/MIT-enkia-tokyo-night-vscode-theme.txt",
        "themes/belafonte-day.json",
        "themes/tokyonight-storm.json",
    ),
    allowed=(
        re.compile(r"^(LICENSE|NOTICE\.md|README\.md|package\.json)$"),
        re.compile(r"^agents/[a-z-]+\.md$"),
        re.compile(r"^extensions/[a-z-]+\.ts$"),
        re.compile(r"^lib/[a-z-]+\.ts$"),
        re.compile(r"^licenses/[A-Za-z0-9.-]+\.txt$"),
        re.compile(r"^settings/[a-z-]+\.json$"),
        re.compile(r"^skills/[a-z-]+/SKILL\.md$"),
        re.compile(r"^themes/[a-z-]+\.json$"),
    ),
    exposes_tools=frozenset(),
    license="MIT AND Apache-2.0 AND CC-BY-SA-4.0",
)

COMPUTER_USE_CONTRACT = PackageContract(
    name="@nredd/pi-computer-use",
    directory="computer-use",
    required=(
        "LICENSE",
        "README.md",
        "package.json",
        "extensions/computer-use.ts",
        "scripts/build-native.mjs",
        "scripts/setup-helper.mjs",
        "native/macos/agent_cursor.swift",
        "native/macos/agent_cursor_motion.swift",
        "native/macos/bridge.swift",
        "prebuilt/macos/arm64/bridge",
        "prebuilt/macos/x64/bridge",
        "native/linux/bridge-rs/Cargo.lock",
        "native/linux/bridge-rs/Cargo.toml",
        "native/linux/bridge-rs/src/atspi.rs",
        "native/linux/bridge-rs/src/error.rs",
        "native/linux/bridge-rs/src/lib.rs",
        "native/linux/bridge-rs/src/main.rs",
        "native/linux/bridge-rs/src/protocol.rs",
        "native/linux/bridge-rs/src/state.rs",
        "native/linux/bridge-rs/src/wayland.rs",
        "native/linux/bridge-rs/src/x11.rs",
    ),
    # macOS ships prebuilts; Linux ships only the locked Rust source (`Cargo.toml`, `Cargo.lock`, `src/*.rs`,
    # no `target/` or `tests/`) that `setup-helper.mjs` builds on opt-in. No `prebuilt/linux` or
    # `prebuilt/windows` pattern exists and no Windows crate or doc is packed. The
    # `src/platform` pattern is source the TypeScript backends reference. `scenario_computer_use`
    # additionally parses each prebuilt's Mach-O header and mode from the tarball.
    allowed=(
        re.compile(r"^(LICENSE|README\.md|package\.json)$"),
        re.compile(r"^assets/reference/img\.jpg$"),
        re.compile(
            r"^docs/(?:architecture|configuration|linux|macos-root-targeting|troubleshooting|usage)\.md$"
        ),
        re.compile(r"^extensions/[a-z-]+\.ts$"),
        re.compile(
            r"^src/(?:[a-z0-9-]+|platform/[a-z0-9-]+|platform/(?:linux|macos|windows)/[a-z0-9-]+(?:\.d)?)\.(?:ts|mts|mjs)$"
        ),
        re.compile(r"^scripts/(?:build-native|setup-helper)\.mjs$"),
        re.compile(r"^native/macos/(?:bridge|agent_cursor|agent_cursor_motion)\.swift$"),
        re.compile(r"^native/linux/bridge-rs/(?:Cargo\.(?:toml|lock)|src/[a-z0-9_]+\.rs)$"),
        re.compile(r"^prebuilt/macos/(?:arm64|x64)/bridge$"),
    ),
    exposes_tools=frozenset(
        {
            "find_roots",
            "observe_ui",
            "search_ui",
            "expand_ui",
            "inspect_ui",
            "act_ui",
            "read_text",
            "wait_for",
            "launch_browser",
            "navigate_browser",
            "evaluate_browser",
            "desktop_screenshot",
            "desktop_input",
        }
    ),
    own_license=True,
    packed_files=(
        "LICENSE",
        "README.md",
        "assets/reference/img.jpg",
        "docs/architecture.md",
        "docs/configuration.md",
        "docs/linux.md",
        "docs/macos-root-targeting.md",
        "docs/troubleshooting.md",
        "docs/usage.md",
        "extensions/computer-use.ts",
        "native/linux/bridge-rs/Cargo.lock",
        "native/linux/bridge-rs/Cargo.toml",
        "native/linux/bridge-rs/src/atspi.rs",
        "native/linux/bridge-rs/src/error.rs",
        "native/linux/bridge-rs/src/lib.rs",
        "native/linux/bridge-rs/src/main.rs",
        "native/linux/bridge-rs/src/protocol.rs",
        "native/linux/bridge-rs/src/state.rs",
        "native/linux/bridge-rs/src/wayland.rs",
        "native/linux/bridge-rs/src/x11.rs",
        "native/macos/agent_cursor.swift",
        "native/macos/agent_cursor_motion.swift",
        "native/macos/bridge.swift",
        "package.json",
        "prebuilt/macos/arm64/bridge",
        "prebuilt/macos/x64/bridge",
        "scripts/build-native.mjs",
        "scripts/setup-helper.mjs",
        "src/actions.ts",
        "src/bridge.ts",
        "src/cdp.ts",
        "src/config.ts",
        "src/contract.ts",
        "src/desktop.ts",
        "src/note.ts",
        "src/outline.ts",
        "src/output.ts",
        "src/permissions.ts",
        "src/platform/architecture.ts",
        "src/platform/coerce.ts",
        "src/platform/index.ts",
        "src/platform/linux/backend.ts",
        "src/platform/linux/helper.ts",
        "src/platform/macos/backend.ts",
        "src/platform/macos/browser.ts",
        "src/platform/macos/helper-path.d.mts",
        "src/platform/macos/helper-path.mjs",
        "src/platform/macos/helper.ts",
        "src/platform/macos/permissions.ts",
        "src/platform/types.ts",
        "src/platform/windows/backend.ts",
        "src/platform/windows/helper.ts",
        "src/root-selection.ts",
        "src/runtime.ts",
        "src/state.ts",
        "src/view.ts",
    ),
)

# `pi-subagents` is deliberately NOT in `CONTRACTS`: `make check-package-contracts` installs its plugins
# offline except for exact published `SHARED_LIBRARIES` pins (the resource sampler), while
# this package has third-party runtime dependencies that must come from the registry. It is audited,
# installed and run through stock Pi by the release `verify` stage (descriptor `stock_gate`), by
# CI's `make check-subagents-package-contract` and by the pack-vs-contract test, not by that target.
# The `files` allowlist in `packages/subagents/package.json` and `allowed`/`required` below must enumerate
# the same set; `test_subagents_pack_matches_contract` enforces it. Peers keep the fork's `>=1.1.0`
# floor (it needs 1.x host APIs) rather than `*`. `SubagentWorkflow` is registered unless the
# `workflowsEnabled` setting is off, which a clean sandbox never sets.
SUBAGENTS_CONTRACT = PackageContract(
    name="@nredd/pi-subagents",
    directory="subagents",
    required=("LICENSE", "README.md", "package.json", "src/index.ts"),
    allowed=(re.compile(r"^(LICENSE|README\.md|package\.json)$"), re.compile(r"^src/.+\.ts$")),
    exposes_tools=frozenset({"Agent", "get_subagent_result", "steer_subagent", "SubagentWorkflow"}),
    runtime_dependencies=(("croner", "^10.0.1"), ("nanoid", "^5.1.16")),
    own_license=True,  # Imported with upstream's `Copyright (c) tintinweb` notice, which MIT requires.
    peer_ranges=(
        ("@earendil-works/pi-ai", ">=1.1.0"),
        ("@earendil-works/pi-coding-agent", ">=1.1.0"),
        ("@earendil-works/pi-tui", ">=1.1.0"),
    ),
)

# `pi-plan-mode` has a registry runtime dependency, so it is its own stock contract, not in
# `CONTRACTS`. `packed_files` pins the exact public payload; build-hashed chunk names are patterns.
PLAN_MODE_CONTRACT = PackageContract(
    name="@nredd/pi-plan-mode",
    directory="plan-mode",
    required=("LICENSE", "README.md", "package.json", "src/index.ts", "dist/index.ts"),
    allowed=(
        re.compile(r"^(LICENSE|README\.md|package\.json)$"),
        re.compile(r"^src/.+\.ts$"),
        re.compile(r"^dist/.+\.(ts|js|map)$"),
        re.compile(r"^docs/.+\.md$"),
    ),
    exposes_tools=frozenset({"plan_mode_question", "plan_mode_complete"}),
    runtime_dependencies=(("@narumitw/pi-tui-kit", "^0.65.2"),),
    own_license=True,
    packed_files=(
        "LICENSE",
        "README.md",
        "dist/index.ts",
        "dist/index.ts.map",
        "docs/command-workflows.md",
        "docs/settings.md",
        "package.json",
        "src/active-implementation-menu.ts",
        "src/command.ts",
        "src/completion-tool.ts",
        "src/decline-contract.ts",
        "src/extension-runtime.ts",
        "src/finalization-request.ts",
        "src/fresh-implementation.ts",
        "src/headless-turn.ts",
        "src/implementation-models.ts",
        "src/implementation-retention.ts",
        "src/index.ts",
        "src/interactive-ui.ts",
        "src/message-transform.ts",
        "src/mode-contract.ts",
        "src/plan-action-controller.ts",
        "src/plan-action-menus.ts",
        "src/plan-approval.ts",
        "src/plan-export-controller.ts",
        "src/plan-export-screen.ts",
        "src/plan-export.ts",
        "src/plan-launch-menu.ts",
        "src/plan-mode.ts",
        "src/presentation.ts",
        "src/prompt.ts",
        "src/question-tool.ts",
        "src/ready-plan-chooser.ts",
        "src/required-tools.ts",
        "src/saved-plan-menu.ts",
        "src/saved-plan-preflight.ts",
        "src/settings-menu.ts",
        "src/settings.ts",
        "src/state.ts",
        "src/tool-availability.ts",
        "src/tool-policy.ts",
        "src/tool-selection.ts",
        "src/workflow-mutex.ts",
    ),
    packed_patterns=(
        (re.compile(r"^dist/chunks/chunk-[A-Z0-9]{8}\.ts$"), 1),
        (re.compile(r"^dist/chunks/chunk-[A-Z0-9]{8}\.ts\.map$"), 1),
        (re.compile(r"^dist/chunks/interactive-ui-[A-Z0-9]{8}\.ts$"), 1),
        (re.compile(r"^dist/chunks/interactive-ui-[A-Z0-9]{8}\.ts\.map$"), 1),
    ),
)


TODO_CONTRACT = PackageContract(
    name="@nredd/pi-todo",
    directory="todo",
    required=("LICENSE", "README.md", "package.json", "index.ts", "todo.ts", "state/store.ts"),
    allowed=(
        re.compile(r"^(LICENSE|README\.md|package\.json)$"),
        re.compile(r"^(config|index|plan-hooks|todo|todo-overlay)\.ts$"),
        re.compile(r"^locales/[A-Za-z-]+\.json$"),
        re.compile(r"^state/[a-z0-9-]+\.ts$"),
        re.compile(r"^tool/[a-z-]+\.ts$"),
        re.compile(r"^view/[a-z-]+\.ts$"),
        re.compile(r"^docs/[a-z0-9.-]+\.md$"),
    ),
    exposes_tools=frozenset({"todo"}),
    runtime_dependencies=(
        ("@juicesharp/rpiv-config", "^2.13.9"),
        ("@juicesharp/rpiv-i18n", "^2.13.9"),
    ),
    own_license=True,
)


# --- schemas --------------------------------------------------------------------------------------

STRICT_MODEL = ConfigDict(extra="forbid", frozen=True)
IGNORE_EXTRA_MODEL = ConfigDict(extra="ignore", frozen=True)

Sha512Integrity = Annotated[str, StringConstraints(pattern=r"^sha512-[A-Za-z0-9+/]{86}==$")]
Sha1Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{40}$")]
Sha256Hex = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
Semver = Annotated[
    str, StringConstraints(pattern=r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
]
NonEmptyText = Annotated[str, StringConstraints(min_length=1)]
TarballName = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$")]


class NpmPackFile(BaseModel):
    model_config = IGNORE_EXTRA_MODEL
    path: NonEmptyText = Field(description="Path relative to the package root")


class NpmPackEntry(BaseModel):
    model_config = IGNORE_EXTRA_MODEL
    filename: TarballName = Field(description="Tarball file name inside the pack destination")
    integrity: Sha512Integrity = Field(description="npm `sha512-` integrity of the tarball")
    shasum: Sha1Hex = Field(description="SHA-1 of the tarball")
    files: list[NpmPackFile] = Field(min_length=1, description="Files npm says it packed")


class PackedManifestIdentity(BaseModel):
    model_config = IGNORE_EXTRA_MODEL
    name: NonEmptyText = Field(description="npm package name")
    version: Semver = Field(description="Package version")


def describe_validation(error: ValidationError) -> str:
    """Render a Pydantic failure as one line per offending field.

    Parameters:
        error (ValidationError): The validation failure.

    Returns:
        str: `; `-joined `field: message` entries.
    """
    return "; ".join(
        f"`{'.'.join(str(part) for part in item['loc']) or '<root>'}`: {item['msg']}"
        for item in error.errors()
    )


UuidV4 = Annotated[
    str, StringConstraints(pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
]
SnapshotMonth = Annotated[str, StringConstraints(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")]
PROTOCOL_MODEL = ConfigDict(extra="forbid", frozen=True, strict=True)
LENIENT_STRICT_MODEL = ConfigDict(extra="ignore", frozen=True, strict=True)
STATS_MAX_BYTES = 128 * 1024 * 1024  # `MAX_BYTES` in `packages/session-kit/src/stats/snapshot.ts`.
STATS_MAX_MS = 8_640_000_000_000_000  # Largest valid JS `Date`, the `positive` bound there.


class PackedPi(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    extensions: list[str] = Field(default_factory=list, description="Extension entry files Pi loads")


class PackedPublishConfig(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    access: str | None = Field(default=None, description="npm package access level")


class PackedManifest(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    name: str | None = Field(default=None, description="npm package name")
    private: bool = Field(default=False, description="Must be absent or `false` for publication")
    publishConfig: PackedPublishConfig = Field(
        default_factory=PackedPublishConfig, description="npm public publication configuration"
    )
    license: str | None = Field(default=None, description="SPDX license identifier")
    dependencies: dict[str, str] = Field(default_factory=dict, description="Runtime dependencies")
    optionalDependencies: dict[str, str] = Field(default_factory=dict, description="Optional dependencies")
    bundledDependencies: list[str] | bool = Field(default=False, description="Bundled dependency names")
    bundleDependencies: list[str] | bool = Field(default=False, description="Alias of `bundledDependencies`")
    peerDependencies: dict[str, str] = Field(default_factory=dict, description="Peer dependency ranges")
    pi: PackedPi = Field(default_factory=PackedPi, description="Pi package manifest section")


class StatsShardRef(BaseModel):
    model_config = PROTOCOL_MODEL
    month: SnapshotMonth = Field(description="UTC month the shard covers")
    file: NonEmptyText = Field(description="Shard file name, exactly `<month>-<sha256>.json`")
    sha256: Sha256Hex = Field(description="SHA-256 of the exact shard bytes")
    bytes: int = Field(ge=0, le=STATS_MAX_BYTES, description="Shard size in bytes")

    @model_validator(mode="after")
    def _file_matches_identity(self) -> Self:
        """Require the documented content-addressed file name.

        Returns:
            Self: The validated model.

        Raises:
            ValueError: If `file` is not `<month>-<sha256>.json`.
        """
        if self.file != f"{self.month}-{self.sha256}.json":
            raise ValueError(f"shard file '{self.file}' is not '{self.month}-{self.sha256}.json'")
        return self


class StatsManifest(BaseModel):
    model_config = PROTOCOL_MODEL
    version: int = Field(ge=1, le=1, description="Snapshot schema version, exactly 1")
    machineId: UuidV4 = Field(description="Persistent installation UUID, matching its directory")
    label: Annotated[str, StringConstraints(min_length=1, max_length=1024)] = Field(
        description="Installation label"
    )
    exportedAt: int = Field(gt=0, le=STATS_MAX_MS, description="Export time, UTC Unix milliseconds")
    shards: list[StatsShardRef] = Field(description="One shard reference per month")

    @model_validator(mode="after")
    def _months_are_unique(self) -> Self:
        """Require exactly one shard per month.

        Returns:
            Self: The validated model.

        Raises:
            ValueError: If a month appears twice.
        """
        months = [ref.month for ref in self.shards]
        if len(set(months)) != len(months):
            raise ValueError(f"duplicate month in shards: {months}")
        return self


class StatsEvent(BaseModel):
    model_config = PROTOCOL_MODEL
    id: Sha256Hex = Field(description="Opaque stable event fingerprint")
    entryId: str | None = Field(description="Preserved entry identity, absent for legacy events")
    sessionId: Sha256Hex = Field(description="Opaque session identity, never a source path")
    ms: int = Field(gt=0, le=STATS_MAX_MS, description="UTC event instant in milliseconds")
    provider: NonEmptyText = Field(description="Physical provider attribution")
    model: NonEmptyText = Field(description="Physical model attribution")
    input: int = Field(ge=0, description="Input tokens")
    output: int = Field(ge=0, description="Output tokens")
    cacheRead: int = Field(ge=0, description="Cache-read tokens")
    cacheWrite: int = Field(ge=0, description="Cache-write tokens")
    cost: float = Field(ge=0, allow_inf_nan=False, description="Notional event cost")


class StatsSession(BaseModel):
    model_config = PROTOCOL_MODEL
    id: Sha256Hex = Field(description="Opaque session identity")
    startMs: int = Field(gt=0, le=STATS_MAX_MS, description="UTC session start in milliseconds")
    endMs: int = Field(gt=0, le=STATS_MAX_MS, description="UTC last event in milliseconds")
    child: bool = Field(description="Whether this session belongs to a subagent")


class StatsShard(BaseModel):
    model_config = PROTOCOL_MODEL
    version: int = Field(ge=1, le=1, description="Month-shard schema version")
    machineId: UuidV4 = Field(description="Producer installation UUID")
    month: SnapshotMonth = Field(description="UTC month covered by this shard")
    events: list[StatsEvent] = Field(description="Usage-only assistant events")
    sessions: list[StatsSession] = Field(description="Usage-only session metadata")


class StatsExportResult(BaseModel):
    model_config = PROTOCOL_MODEL
    machineId: UuidV4 = Field(description="Installation UUID that exported")
    snapshotDir: NonEmptyText = Field(description="`<OUT>/machines/<UUID>` directory written")


class StatsImportResult(BaseModel):
    model_config = PROTOCOL_MODEL
    imported: int = Field(ge=0, description="Machines imported this run")
    retained: int = Field(ge=0, description="Machines kept from earlier imports")
    problems: list[str] = Field(description="Coverage problems found")
    importedAt: int = Field(ge=0, le=STATS_MAX_MS, description="Last successful import, Unix milliseconds")


class ToolContentBlock(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    type: str = Field(description="Content block kind")
    text: str = Field(default="", description="Text of a `text` block")


class ToolResult(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    content: list[ToolContentBlock] = Field(description="Result content blocks")
    structuredContent: dict[str, object] | None = Field(
        default=None, description="Tool-specific payload, opaque until a scenario reads it"
    )


class ToolRecord(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    result: ToolResult = Field(description="Tool result payload")


class ToolOutcome(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    isError: bool = Field(description="Whether the tool reported failure")


class MessageEnvelope(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    role: str | None = Field(default=None, description="Message author role")
    provider: str | None = Field(default=None, description="Provider that served an assistant message")
    model: str | None = Field(default=None, description="Model that served an assistant message")


class MessageEndEvent(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    message: MessageEnvelope = Field(description="Finished message")


class LockEntry(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    version: str | None = Field(default=None, description="Locked version")
    integrity: str | None = Field(default=None, description="Locked registry integrity")
    resolved: str | None = Field(default=None, description="Locked tarball URL")
    optional: bool = Field(default=False, description="npm marked this entry optional")
    dependencies: dict[str, str] = Field(default_factory=dict, description="Direct locked dependencies")


class PublishedDist(BaseModel):
    """`npm view <name>@<version> dist --json`: the registry's own tarball identity."""

    model_config = LENIENT_STRICT_MODEL
    tarball: NonEmptyText = Field(description="Published tarball URL")
    integrity: Sha512Integrity = Field(description="Published npm `sha512-` integrity")


class LockFile(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    packages: dict[str, LockEntry] = Field(description="Lock entries by `node_modules/` path")


def parse_stats_json[M: BaseModel](model: type[M], text: str, what: str) -> M:
    """Parse and validate one stats protocol document.

    Parameters:
        model (type[M]): Boundary model.
        text (str): Raw JSON text.
        what (str): Document name for diagnostics, e.g. `manifest`.

    Returns:
        M: The validated document.

    Raises:
        ContractError: If the text is not JSON or does not match the documented shape.
    """
    try:
        return model.model_validate_json(text)
    except ValidationError as e:
        raise ContractError(f"Malformed stats {what}: {describe_validation(e)}") from e


class DevToolsEvidence(TypedDict):
    """Return shape of `scenario_dev_tools`."""

    tool: str
    untracked: list[str]
    failure_path: str
    resource_ranking: str
    resource_sampler_integrity: str
    resource_failure_path: str


class SessionKitEvidence(TypedDict):
    """Return shape of `scenario_session_kit`."""

    tools: list[str]
    monitor_line: str
    stats_shards: int


class RouterEvidence(TypedDict):
    """Return shape of `scenario_router`."""

    virtual_model: str
    dispatched: str
    balanced: list[str]
    fallback: list[str]
    recovery: list[str]


class SubagentsEvidence(TypedDict):
    """Return shape of `scenario_subagents`."""

    tools: list[str]
    child_text: str


class ComputerUseEvidence(TypedDict):
    """Stock-Pi declaration evidence, explicitly excluding native desktop execution."""

    platform: str
    tools: list[str]
    helpers: dict[str, str]
    helper_sources: list[str]
    postinstall: Literal["NOT RUN"]
    postinstall_reason: str
    native_desktop: Literal["NOT RUN"]
    native_desktop_reason: str


class PlanModeEvidence(TypedDict):
    """Return shape of `scenario_plan_mode`.

    Parameters:
        tools (list[str]): Sorted Plan tools the packed extension exposes.
        question_result (str): Text of the `plan_mode_question` result (`ui_unavailable` headless).
    """

    tools: list[str]
    question_result: str


class TodoEvidence(TypedDict):
    """Return shape of `scenario_todo`."""

    tools: list[str]
    subject: str


ScenarioEvidence = (
    DevToolsEvidence
    | SessionKitEvidence
    | RouterEvidence
    | SubagentsEvidence
    | PlanModeEvidence
    | TodoEvidence
    | ComputerUseEvidence
)


class DevToolsEvidenceModel(BaseModel):
    model_config = STRICT_MODEL
    tool: Literal["git_status"] = Field(description="Tool the scenario ran")
    untracked: list[str] = Field(min_length=1, description="Untracked paths the real tool reported")
    failure_path: NonEmptyText = Field(description="Error text from the outside-a-repository run")
    resource_ranking: Literal["interval-cpu", "rss"] = Field(
        description="`resource_snapshot` ranking on the host that found the marker child under its parent"
    )
    resource_sampler_integrity: Sha512Integrity = Field(
        description="Locked registry integrity of the installed `@nredd/pi-resource-sampler`"
    )
    resource_failure_path: NonEmptyText = Field(
        description="Error text from an out-of-bounds `process_limit`"
    )


class SessionKitEvidenceModel(BaseModel):
    model_config = STRICT_MODEL
    tools: list[Literal["monitor_start", "monitor_read"]] = Field(
        min_length=1, description="Monitor tools the scenario exercised"
    )
    monitor_line: NonEmptyText = Field(description="Marker line the monitor captured")
    stats_shards: int = Field(ge=1, description="Shards in the exported stats manifest")


class RouterEvidenceModel(BaseModel):
    model_config = STRICT_MODEL
    virtual_model: Literal["router/default"] = Field(description="Virtual model that was requested")
    dispatched: Annotated[str, StringConstraints(pattern=r"^[^/\s]+/[^/\s]+$")] = Field(
        description="`provider/model` the virtual model dispatched to"
    )

    balanced: list[Literal["openai-codex/m-b"]] = Field(
        min_length=1, max_length=1, description="Balanced dispatch"
    )
    fallback: list[Literal["local/m-c"]] = Field(
        min_length=1, max_length=1, description="Unmeasured fallback"
    )
    recovery: list[Literal["anthropic/m-a", "openai-codex/m-b"]] = Field(
        min_length=2, max_length=2, description="Confirmed quota recovery attempts"
    )


class SubagentsEvidenceModel(BaseModel):
    model_config = STRICT_MODEL
    tools: list[NonEmptyText] = Field(min_length=1, description="Tools the model was offered by the package")
    child_text: NonEmptyText = Field(description="Answer the foreground `Agent` call returned from its child")


class ComputerUseEvidenceModel(BaseModel):
    model_config = STRICT_MODEL
    platform: NonEmptyText = Field(description="Host `sys.platform` that selected the expected tool set")
    tools: list[NonEmptyText] = Field(min_length=1, description="Exact tool set the model was offered")
    helpers: dict[str, NonEmptyText] = Field(
        min_length=1, description="Packed Mach-O check per prebuilt arch"
    )
    helper_sources: list[NonEmptyText] = Field(
        min_length=1, description="Swift sources the packed build scripts compile, each verified packed"
    )
    postinstall: Literal["NOT RUN"] = Field(description="`setup-helper.mjs` was not exercised")
    postinstall_reason: NonEmptyText = Field(description="Why the postinstall was not exercised")
    native_desktop: Literal["NOT RUN"] = Field(description="Native desktop behavior was not exercised")
    native_desktop_reason: NonEmptyText = Field(description="Why native desktop behavior was not exercised")


class PlanModeEvidenceModel(BaseModel):
    model_config = STRICT_MODEL
    tools: list[NonEmptyText] = Field(min_length=2, description="Plan tools offered by the packed extension")
    question_result: NonEmptyText = Field(description="Result of the exercised Plan question tool")


class TodoEvidenceModel(BaseModel):
    model_config = STRICT_MODEL
    tools: list[Literal["todo"]] = Field(
        min_length=1, description="Todo tool offered by the packed extension"
    )
    subject: NonEmptyText = Field(description="Subject persisted by the exercised todo call")


EVIDENCE_MODELS: dict[str, type[BaseModel]] = {
    "@nredd/pi-computer-use": ComputerUseEvidenceModel,
    "@nredd/pi-subagents": SubagentsEvidenceModel,
    "@nredd/pi-dev-tools": DevToolsEvidenceModel,
    "@nredd/pi-session-kit": SessionKitEvidenceModel,
    "@nredd/pi-subscription-router": RouterEvidenceModel,
    "@nredd/pi-plan-mode": PlanModeEvidenceModel,
    "@nredd/pi-todo": TodoEvidenceModel,
}


class StockPiIdentity(BaseModel):
    model_config = STRICT_MODEL
    package: str = Field(description="Stock Pi npm package name")
    version: Semver = Field(description="Stock Pi version")
    integrity: Sha512Integrity = Field(description="Stock Pi tarball integrity")

    @model_validator(mode="after")
    def _is_pinned(self) -> Self:
        """Reject any identity that is not the pinned one.

        Returns:
            Self: The validated model.

        Raises:
            ValueError: If the package, version or integrity differs from the pins.
        """
        pinned = (STOCK_PI_PACKAGE, STOCK_PI_VERSION, STOCK_PI_INTEGRITY)
        if (self.package, self.version, self.integrity) != pinned:
            raise ValueError(f"stock Pi identity is not the pinned {pinned!r}")
        return self


class PackageReport(BaseModel):
    model_config = STRICT_MODEL
    version: Semver = Field(description="Packed package version")
    tarball: TarballName = Field(description="Tarball file name")
    integrity: Sha512Integrity = Field(description="npm `sha512-` integrity of the tarball")
    shasum: Sha1Hex = Field(description="SHA-1 of the tarball")
    size: int = Field(gt=0, description="Tarball size in bytes")
    files: list[NonEmptyText] = Field(min_length=1, description="Files in the packed tarball")
    evidence: (
        DevToolsEvidenceModel
        | SessionKitEvidenceModel
        | RouterEvidenceModel
        | SubagentsEvidenceModel
        | PlanModeEvidenceModel
        | TodoEvidenceModel
        | ComputerUseEvidenceModel
    ) = Field(description="Scenario evidence for this package")


class ContractReport(BaseModel):
    model_config = STRICT_MODEL
    stock_pi: StockPiIdentity = Field(description="Pinned stock Pi identity")
    node: Annotated[str, StringConstraints(pattern=r"^v\d+\.\d+\.\d+")] = Field(
        description="Node version that ran the contracts"
    )
    npm: Semver = Field(description="npm version that ran the contracts")
    license_sha256: Sha256Hex = Field(description="SHA-256 of the shared license text")
    packages: dict[str, PackageReport] = Field(
        min_length=1, description="Report entry per packed package name"
    )

    @model_validator(mode="after")
    def _packages_match_contracts(self) -> Self:
        """Cross-check each package entry against its contract.

        Returns:
            Self: The validated model.

        Raises:
            ValueError: If a package is unknown, its tarball name or file list is inconsistent, or its
                evidence belongs to another package.
        """
        for name, entry in self.packages.items():
            expected_model = EVIDENCE_MODELS.get(name)
            if expected_model is None:
                raise ValueError(f"unknown package '{name}'")
            if not isinstance(entry.evidence, expected_model):
                raise ValueError(f"evidence for '{name}' is a `{type(entry.evidence).__name__}`")
            expected_tarball = f"{name.removeprefix('@').replace('/', '-')}-{entry.version}.tgz"
            if entry.tarball != expected_tarball:
                raise ValueError(f"tarball '{entry.tarball}' is not '{expected_tarball}'")
            if len(set(entry.files)) != len(entry.files):
                raise ValueError(f"duplicate files for '{name}'")
        return self


def validate_report(raw: Mapping[str, object]) -> ContractReport:
    """Validate a report at the serialization boundary.

    Parameters:
        raw (Mapping[str, object]): Report assembled from artifacts and scenario evidence.

    Returns:
        ContractReport: The validated report.

    Raises:
        ContractError: If any identity or evidence field is malformed.
    """
    try:
        return ContractReport.model_validate(raw)
    except ValidationError as e:
        raise ContractError(f"Report failed validation:\n{e}") from e


def serialize_report(report: ContractReport) -> str:
    """Serialize a validated report as indented JSON.

    Parameters:
        report (ContractReport): Validated report.

    Returns:
        str: JSON text ending in a newline.
    """
    return report.model_dump_json(indent=2) + "\n"


@dataclass(frozen=True)
class PackedArtifact:
    """Identity of one built tarball.

    Parameters:
        contract (PackageContract): Package the tarball belongs to.
        path (Path): Tarball location.
        version (str): Package version from the packed manifest.
        integrity (str): npm `sha512-` integrity.
        shasum (str): SHA-1 as reported by `npm pack`.
        size (int): Tarball size in bytes.
        files (tuple[str, ...]): Paths inside the tarball without the `package/` prefix.
    """

    contract: PackageContract
    path: Path
    version: str
    integrity: str
    shasum: str
    size: int
    files: tuple[str, ...]


@dataclass(frozen=True)
class Tools:
    """Absolute paths of the executables the gate runs.

    Parameters:
        node (Path): `node`.
        npm (Path): `npm`.
        git (Path): `git`.
    """

    node: Path
    npm: Path
    git: Path


@dataclass
class Sandbox:
    """Scrubbed process environment rooted in a temporary directory.

    Parameters:
        root (Path): Directory holding `home`, `agent`, `tmp` and `npm-cache`.
        tools (Tools): Executables available on `PATH`.
        extra (dict[str, str]): Additional environment entries layered over the scrubbed base.
    """

    root: Path
    tools: Tools
    extra: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Create the directory skeleton and empty npm config files."""
        for name in (
            "home",
            "agent",
            "tmp",
            "npm-cache",
            "codex",
            "xdg/config",
            "xdg/cache",
            "xdg/data",
            "xdg/state",
        ):
            (self.root / name).mkdir(parents=True, exist_ok=True)
        for name in ("npmrc-user", "npmrc-global"):
            (self.root / name).touch()

    @property
    def agent_dir(self) -> Path:
        """Isolated Pi agent directory (`PI_CODING_AGENT_DIR`).

        Returns:
            Path: `<root>/agent`.
        """
        return self.root / "agent"

    def env(self) -> dict[str, str]:
        """Build a minimal environment with no credentials or real config.

        Returns:
            dict[str, str]: The full environment for a child process.
        """
        bin_dirs = list(dict.fromkeys(str(tool.parent) for tool in (self.tools.node, self.tools.git)))
        env = {
            "PATH": os.pathsep.join([*bin_dirs, "/usr/bin", "/bin"]),
            "HOME": str(self.root / "home"),
            "TMPDIR": str(self.root / "tmp"),
            "TMP": str(self.root / "tmp"),
            "TEMP": str(self.root / "tmp"),
            "XDG_CONFIG_HOME": str(self.root / "xdg" / "config"),
            "XDG_CACHE_HOME": str(self.root / "xdg" / "cache"),
            "XDG_DATA_HOME": str(self.root / "xdg" / "data"),
            "XDG_STATE_HOME": str(self.root / "xdg" / "state"),
            "CODEX_HOME": str(self.root / "codex"),
            "LANG": "C.UTF-8",
            "PI_CODING_AGENT_DIR": str(self.agent_dir),
            "PI_OFFLINE": "1",
            "PI_SKIP_VERSION_CHECK": "1",
            "PI_TELEMETRY": "0",
            "HTTP_PROXY": DEAD_PROXY,
            "HTTPS_PROXY": DEAD_PROXY,
            "NO_PROXY": NO_PROXY_VALUE,
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
            "npm_config_cache": str(self.root / "npm-cache"),
            "npm_config_userconfig": str(self.root / "npmrc-user"),
            "npm_config_globalconfig": str(self.root / "npmrc-global"),
            "npm_config_update_notifier": "false",
        }
        return env | self.extra


def run(
    cmd: Sequence[str | Path],
    *,
    env: dict[str, str],
    cwd: Path,
    timeout: int,
    check: bool = True,
    own_group: bool = False,
) -> subprocess.CompletedProcess[str]:
    """Run an absolute-path command without a shell.

    Parameters:
        cmd (Sequence[str | Path]): Argument vector; `cmd[0]` must be absolute.
        env (dict[str, str]): Complete child environment.
        cwd (Path): Working directory.
        timeout (int): Seconds before the child is killed.
        check (bool): Raise `ContractError` on a nonzero exit.
        own_group (bool): Run through `run_own_group`, so a Python-level timeout or
            `KeyboardInterrupt` kills the child's whole process group while its leader is
            unreaped. Default `subprocess.run` kills only the child.

    Returns:
        subprocess.CompletedProcess[str]: Captured text output.

    Raises:
        ContractError: On timeout, or on nonzero exit when `check` is set.
    """
    argv = [str(part) for part in cmd]
    if not Path(argv[0]).is_absolute():
        raise ValueError(f"Executable must be an absolute path: '{argv[0]}'")
    try:
        if own_group:
            done = run_own_group(argv, env=env, cwd=cwd, timeout=timeout)
        else:
            done = subprocess.run(
                argv,
                env=env,
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
                stdin=subprocess.DEVNULL,
            )
    except subprocess.TimeoutExpired as e:
        raise ContractError(f"`{' '.join(argv[:3])}` timed out after {timeout}s") from e
    if check and done.returncode != 0:
        raise ContractError(
            f"`{' '.join(argv[:3])}` exited {done.returncode}\n"
            f"stdout: {done.stdout[-2000:]}\nstderr: {done.stderr[-2000:]}"
        )
    return done


def run_own_group(
    argv: list[str], *, env: dict[str, str], cwd: Path, timeout: int
) -> subprocess.CompletedProcess[str]:
    """Run `argv` as the leader of a new session; on timeout or interruption kill its whole group.

    The group is signalled only while the leader is unreaped (`returncode` unset, read without a
    `poll` that could reap it): until then its pid, the group id, cannot be reused, like
    `integration/harness/headless.py` `kill_process_group`. If `communicate` already reaped the
    leader (its SIGINT grace wait can), the id may be reused, so nothing is signalled and the
    original exception says so, and surviving members may outlive the gate. Members left after a
    normal exit are the program's own job. Only exceptions raised in this process run the cleanup:
    a SIGTERM or SIGHUP without a Python handler, or a SIGKILL, ends the gate with no cleanup and
    the group may outlive it.

    Parameters:
        argv (list[str]): Argument vector; `argv[0]` is absolute.
        env (dict[str, str]): Complete child environment.
        cwd (Path): Working directory.
        timeout (int): Seconds before the group is killed.

    Returns:
        subprocess.CompletedProcess[str]: Captured text output.

    Raises:
        subprocess.TimeoutExpired: After the group was killed and the leader reaped.
    """
    with subprocess.Popen(
        argv,
        env=env,
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    ) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except BaseException as e:
            if process.returncode is None:
                with suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            else:
                e.add_note(f"process group {process.pid} not signalled: its leader was already reaped")
            raise
    return subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)


def locate_tools() -> Tools:
    """Resolve `node`, `npm` and `git` once so later runs never consult an untrusted `PATH`.

    Returns:
        Tools: Absolute executable paths.

    Raises:
        ContractError: If any executable is missing.
    """
    return Tools(node=locate_executable("node"), npm=locate_executable("npm"), git=locate_executable("git"))


def locate_executable(name: str) -> Path:
    """Resolve one executable on `PATH` to an absolute, symlink-free path.

    Parameters:
        name (str): Executable name.

    Returns:
        Path: Absolute path.

    Raises:
        ContractError: If the executable is missing.
    """
    located = shutil.which(name)
    if located is None:
        raise ContractError(f"`{name}` not found on PATH")
    return Path(located).resolve()


# --- stock Pi -------------------------------------------------------------------------------------


def ensure_stock_pi(prefix: Path, sandbox: Sandbox) -> Path:
    """Install exact stock Pi into `prefix` if needed, then verify its identity.

    Parameters:
        prefix (Path): Install directory, kept outside the source tree and reused across runs.
        sandbox (Sandbox): Environment for `npm`.

    Returns:
        Path: The `pi` executable.

    Raises:
        ContractError: If the installed version or registry integrity differs from the pins.
    """
    # npm keys its lockfile by realpath; a symlinked prefix (macOS `/var` -> `/private/var`) would
    # yield `../../private/...` keys that `verify_stock_pi` cannot find.
    prefix = prefix.resolve()
    prefix.mkdir(parents=True, exist_ok=True)
    manifest = prefix / "package.json"
    if not manifest.exists():
        manifest.write_text(
            json.dumps(
                {"name": "pi-stock", "private": True, "dependencies": {STOCK_PI_PACKAGE: STOCK_PI_VERSION}},
                indent=2,
            )
            + "\n"
        )
    pi_bin = prefix / "node_modules" / ".bin" / "pi"
    if not pi_bin.exists():
        LOGGER.info(f"Installing {STOCK_PI_PACKAGE}@{STOCK_PI_VERSION} into '{prefix}'")
        run(
            [sandbox.tools.npm, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix],
            env=sandbox.env() | REGISTRY_ENV,
            cwd=prefix,
            timeout=NPM_TIMEOUT_S,
        )
    verify_stock_pi(prefix, pi_bin, sandbox)
    return pi_bin


def read_lockfile(path: Path) -> LockFile:
    """Read the consumed part of an npm `package-lock.json`.

    Parameters:
        path (Path): Lockfile path.

    Returns:
        LockFile: Entries by `node_modules/` path.

    Raises:
        ContractError: If the file is unreadable, not JSON, or lacks a well-formed `packages` map.
    """
    try:
        return LockFile.model_validate_json(path.read_text())
    except (OSError, ValidationError) as e:
        raise ContractError(f"Malformed lockfile '{path}': {e}") from e


def verify_stock_pi(prefix: Path, pi_bin: Path, sandbox: Sandbox) -> None:
    """Check the installed Pi is exactly the pinned registry artifact.

    Parameters:
        prefix (Path): Install directory.
        pi_bin (Path): The `pi` executable.
        sandbox (Sandbox): Environment for the version probe.

    Raises:
        ContractError: On any identity mismatch.
    """
    lock = read_lockfile(prefix / "package-lock.json")
    entry = lock.packages.get(f"node_modules/{STOCK_PI_PACKAGE}", LockEntry())
    if entry.version != STOCK_PI_VERSION or entry.integrity != STOCK_PI_INTEGRITY:
        raise ContractError(
            f"Stock Pi in '{prefix}' is {entry.version!r} / {entry.integrity!r}, "
            f"expected {STOCK_PI_VERSION!r} / {STOCK_PI_INTEGRITY!r}"
        )
    reported = run([pi_bin, "--version"], env=sandbox.env(), cwd=prefix, timeout=PI_TIMEOUT_S).stdout.strip()
    if reported != STOCK_PI_VERSION:
        raise ContractError(f"`pi --version` reported '{reported}', expected '{STOCK_PI_VERSION}'")


# --- tarball audit --------------------------------------------------------------------------------


def pack(
    contract: PackageContract, dest: Path, sandbox: Sandbox, package_dir: Path | None = None
) -> PackedArtifact:
    """Run `npm pack` for one workspace package.

    Parameters:
        contract (PackageContract): Package to pack.
        dest (Path): Directory receiving the tarball.
        sandbox (Sandbox): Environment for `npm`.
        package_dir (Path | None): Directory to pack; defaults to the workspace package.

    Returns:
        PackedArtifact: Identity and file list as reported by npm and re-read from the tarball.

    Raises:
        ContractError: If npm output is malformed or disagrees with the tarball.
    """
    package_dir = package_dir or REPO_ROOT / "packages" / contract.directory
    done = run(
        [sandbox.tools.npm, "pack", "--json", "--ignore-scripts", "--pack-destination", dest],
        env=sandbox.env(),
        cwd=package_dir,
        timeout=NPM_TIMEOUT_S,
    )
    try:
        (report,) = TypeAdapter(list[NpmPackEntry]).validate_json(done.stdout)
    except (ValidationError, ValueError) as e:
        raise ContractError(
            f"Unparseable `npm pack --json` output for '{contract.name}': {done.stdout[:500]}"
        ) from e
    path = dest / report.filename
    data = path.read_bytes()
    digest = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()
    if digest != report.integrity or hashlib.sha1(data, usedforsecurity=False).hexdigest() != report.shasum:
        raise ContractError(f"`npm pack` identity for '{contract.name}' disagrees with the tarball bytes")
    with tarfile.open(path) as tar:
        files = tarball_files(tar, path)
    if files != tuple(sorted(entry.path for entry in report.files)):
        raise ContractError(f"`npm pack` file list for '{contract.name}' disagrees with its tarball")
    try:
        manifest = PackedManifestIdentity.model_validate_json(read_member(path, "package.json"))
    except ValidationError as e:
        raise ContractError(f"Packed `package.json` of '{contract.name}' has no usable identity: {e}") from e
    return PackedArtifact(contract, path, manifest.version, report.integrity, report.shasum, len(data), files)


def load_tarball(contract: PackageContract, path: Path) -> PackedArtifact:
    """Read an existing tarball without packing or changing its bytes.

    Parameters:
        contract (PackageContract): Expected package.
        path (Path): Existing npm tarball.

    Returns:
        PackedArtifact: Identity computed directly from the supplied bytes.

    Raises:
        ContractError: If the path, archive, or package identity is invalid.
    """
    path = path.resolve()
    if not path.is_file():
        raise ContractError(f"Tarball is not a regular file: '{path}'")
    try:
        data = path.read_bytes()
        manifest = PackedManifestIdentity.model_validate_json(read_member(path, "package.json"))
        with tarfile.open(path) as tar:
            files = tarball_files(tar, path)
    except (OSError, ValueError, tarfile.TarError) as e:
        raise ContractError(f"Cannot read tarball '{path}': {e}") from e
    if manifest.name != contract.name:
        raise ContractError(f"Tarball names '{manifest.name}', expected '{contract.name}'")
    expected = f"{contract.name.removeprefix('@').replace('/', '-')}-{manifest.version}.tgz"
    if path.name != expected:
        raise ContractError(f"Tarball name '{path.name}' must be '{expected}'")
    return PackedArtifact(
        contract,
        path,
        manifest.version,
        "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode(),
        hashlib.sha1(data, usedforsecurity=False).hexdigest(),
        len(data),
        files,
    )


def parse_tarballs(values: Sequence[str], contracts: Sequence[PackageContract]) -> dict[str, Path]:
    """Validate explicit `DIRECTORY=PATH` inputs before any install or Pi run.

    Parameters:
        values (Sequence[str]): CLI input pairs.
        contracts (Sequence[PackageContract]): Packages this gate supports.

    Returns:
        dict[str, Path]: Existing tarball paths keyed by package directory.

    Raises:
        ContractError: If a pair is unknown, duplicated, missing or invalid.
    """
    allowed = {c.directory: c for c in contracts}
    result: dict[str, Path] = {}
    for value in values:
        directory, separator, raw_path = value.partition("=")
        if not separator or not raw_path or directory not in allowed or directory in result:
            raise ContractError(f"Invalid or duplicate `--tarball DIRECTORY=PATH`: '{value}'")
        path = Path(raw_path).resolve()
        load_tarball(allowed[directory], path)
        result[directory] = path
    return result


def select_artifact(
    contract: PackageContract,
    dest: Path,
    sandbox: Sandbox,
    tarballs: Mapping[str, Path],
    package_dir: Path | None = None,
) -> PackedArtifact:
    """Use supplied bytes in preference to packing a companion package.

    Parameters:
        contract (PackageContract): Package to load or pack.
        dest (Path): Destination for newly packed companions.
        sandbox (Sandbox): npm environment.
        tarballs (Mapping[str, Path]): Explicit paths by package directory.
        package_dir (Path | None): Optional companion source path.

    Returns:
        PackedArtifact: The supplied artifact, or a freshly packed companion.
    """
    if contract.directory in tarballs:
        return load_tarball(contract, tarballs[contract.directory])
    return pack(contract, dest, sandbox, package_dir)


def tarball_files(tar: tarfile.TarFile, path: Path) -> tuple[str, ...]:
    """Return regular file paths while rejecting special tarball members.

    Parameters:
        tar (tarfile.TarFile): Open package archive.
        path (Path): Archive path for diagnostics.

    Returns:
        tuple[str, ...]: Sorted paths relative to npm's `package/` prefix.

    Raises:
        ContractError: If the archive contains a symlink, hardlink, or other special member.
    """
    members = tar.getmembers()
    invalid = [member.name for member in members if not member.isfile() and not member.isdir()]
    if invalid:
        raise ContractError(f"Tarball '{path.name}' has non-regular member(s): {sorted(invalid)}")
    return tuple(sorted(strip_prefix(member.name) for member in members if member.isfile()))


def strip_prefix(name: str) -> str:
    """Drop npm's leading `package/` directory.

    Parameters:
        name (str): Tar member name.

    Returns:
        str: Path relative to the package root.
    """
    return PurePosixPath(name).relative_to("package").as_posix()


def read_member(tarball: Path, name: str) -> bytes:
    """Read one file out of an npm tarball.

    Parameters:
        tarball (Path): Tarball path.
        name (str): Path relative to the package root.

    Returns:
        bytes: File content.

    Raises:
        ContractError: If the member is absent or not a regular file.
    """
    with tarfile.open(tarball) as tar:
        try:
            member = tar.getmember(f"package/{name}")
        except KeyError as e:
            raise ContractError(f"'{tarball.name}' has no '{name}'") from e
        handle = tar.extractfile(member)
        if handle is None:
            raise ContractError(f"'{tarball.name}:{name}' is not a regular file")
        return handle.read()


def audit_files(contract: PackageContract, files: Sequence[str]) -> list[str]:
    """Check a tarball file list against the contract allowlist.

    Parameters:
        contract (PackageContract): Expectations.
        files (Sequence[str]): Tarball paths relative to the package root.

    Returns:
        list[str]: Violations; empty when the list conforms.
    """
    problems = [f"missing required file '{name}'" for name in contract.required if name not in files]
    problems += [
        f"unexpected file '{name}'"
        for name in files
        if not any(pattern.match(name) for pattern in contract.allowed)
    ]
    if contract.packed_files or contract.packed_patterns:
        counts = Counter(files)
        problems += [
            f"packed file '{name}' is listed {count} times" for name, count in counts.items() if count > 1
        ]
        unmatched = [name for name in counts if name not in contract.packed_files]
        for pattern, count in contract.packed_patterns:
            matched = [name for name in unmatched if pattern.match(name)]
            unmatched = [name for name in unmatched if name not in matched]
            if len(matched) != count:
                problems.append(
                    f"expected {count} packed file(s) matching '{pattern.pattern}', got {matched}"
                )
            problems += [
                f"packed source map '{name}' has no '{name.removesuffix('.map')}'"
                for name in matched
                if name.endswith(".map") and name.removesuffix(".map") not in counts
            ]
        problems += [f"packed file '{name}' is not in the '{contract.name}' contract" for name in unmatched]
        problems += [
            f"packed file '{name}' required by the '{contract.name}' contract is missing"
            for name in contract.packed_files
            if name not in counts
        ]
    return problems


def audit_chunk_graph(
    contract: PackageContract, files: Sequence[str], scanned: Mapping[str, FileImports]
) -> list[str]:
    """Require every pattern-matched chunk to be reachable from `dist/index.ts` by relative imports.

    A chunk whose name merely fits a hashed pattern, but nothing in the bundle loads, is an orphan
    (stray or swapped file). Each `.map` must also pair with its `.ts`, which `audit_files` checks.

    Parameters:
        contract (PackageContract): Expectations.
        files (Sequence[str]): Tarball paths relative to the package root.
        scanned (Mapping[str, FileImports]): Parsed imports by packed code path.

    Returns:
        list[str]: Violations; empty when every matched chunk is reachable.
    """
    chunks = {
        name
        for name in files
        if name.endswith(".ts") and any(pattern.match(name) for pattern, _ in contract.packed_patterns)
    }
    code = {name for name in files if name.endswith(CODE_SUFFIXES)}
    reached: set[str] = set()
    pending = ["dist/index.ts"]
    while pending:
        current = pending.pop()
        found = scanned.get(current)
        for spec in found.specifiers if found else ():
            if not spec.startswith("."):
                continue
            target = PurePosixPath(os.path.normpath(PurePosixPath(current).parent / spec)).as_posix()
            if target in code and target not in reached:
                reached.add(target)
                pending.append(target)
    return [
        f"packed chunk '{name}' is not reachable from 'dist/index.ts' by relative imports"
        for name in sorted(chunks - reached)
    ]


def audit_license(tarball: Path, expected_license: bytes) -> list[str]:
    """Require the packed `LICENSE` to equal the expected license byte for byte.

    Parameters:
        tarball (Path): Tarball path.
        expected_license (bytes): Expected content: the repository `LICENSE`, or the workspace's own for a
            contract with `own_license`.

    Returns:
        list[str]: Violations; empty when identical.
    """
    try:
        packed = read_member(tarball, "LICENSE")
    except ContractError as e:
        return [str(e)]
    return [] if packed == expected_license else ["packed `LICENSE` differs from the expected `LICENSE`"]


def shared_library_pin_problems(contract: PackageContract) -> list[str]:
    """Check that every `SHARED_LIBRARIES` dependency the contract declares uses the common pin.

    `classify_imports` only sees dependency names, so without this a second consumer could declare
    the sampler at another exact version and still import it.

    Parameters:
        contract (PackageContract): Expectations to check.

    Returns:
        list[str]: Violations; empty when every shared library is pinned at its common version.
    """
    return [
        f"'{contract.name}' declares shared library '{name}' at '{declared}', "
        f"not the common pin '{SHARED_LIBRARIES[name]}'"
        for name, declared in contract.runtime_dependencies
        if name in SHARED_LIBRARIES and declared != SHARED_LIBRARIES[name]
    ]


def audit_manifest(contract: PackageContract, manifest: object, expected_files: Sequence[str]) -> list[str]:
    """Check the packed `package.json` for independence and publication safety.

    Only the audited fields are validated (see `PackedManifest`); other npm metadata is ignored on
    purpose. A malformed audited field is reported as a violation, never skipped.

    Parameters:
        contract (PackageContract): Expectations.
        manifest (object): Parsed packed manifest JSON value.
        expected_files (Sequence[str]): Files that must be reachable through `pi.extensions`.

    Returns:
        list[str]: Violations; empty when the manifest conforms.
    """
    try:
        parsed = PackedManifest.model_validate(manifest)
    except ValidationError as e:
        return [
            f"packed `package.json` field `{'.'.join(str(part) for part in item['loc']) or '<root>'}` "
            f"is malformed: {item['msg']}"
            for item in e.errors()
        ]
    problems = shared_library_pin_problems(contract)
    if parsed.name != contract.name:
        problems.append(f"name is '{parsed.name}', expected '{contract.name}'")
    if parsed.private is True:
        problems.append("`private` must be absent or `false` for publication")
    if parsed.publishConfig.access != "public":
        problems.append("`publishConfig.access` must be `public`")
    if parsed.license != contract.license:
        problems.append(f"`license` must be '{contract.license}'")
    declared = {
        "optionalDependencies": parsed.optionalDependencies,
        "bundledDependencies": parsed.bundledDependencies,
        "bundleDependencies": parsed.bundleDependencies,
    }
    problems += [
        f"`{key}` must be empty: host modules are peers and plugins are independent"
        for key, value in declared.items()
        if value
    ]
    allowed_dependencies = dict(contract.runtime_dependencies)
    problems += [
        f"dependency '{name}' is not a declared runtime dependency of '{contract.name}'"
        for name in parsed.dependencies
        if name not in allowed_dependencies
    ]
    problems += [
        f"dependency '{name}' must use the range '{allowed_dependencies[name]}', "
        f"not '{parsed.dependencies[name]}'"
        for name in parsed.dependencies
        if name in allowed_dependencies and parsed.dependencies[name] != allowed_dependencies[name]
    ]
    problems += [
        f"declared runtime dependency '{name}' is missing"
        for name in allowed_dependencies
        if name not in parsed.dependencies
    ]
    peers = parsed.peerDependencies
    problems += [f"peer '{name}' is not a host module" for name in peers if name not in HOST_MODULES]
    for name, declared_range in peers.items():
        expected_range = dict(contract.peer_ranges).get(name, "*")
        if declared_range != expected_range:
            problems.append(f"peer '{name}' must use the range '{expected_range}', not '{declared_range}'")
    if contract.library:
        if not isinstance(manifest, dict):
            return [*problems, "library manifest must be an object"]
        if "pi" in manifest or peers:
            problems.append("library must not declare `pi` resources or host peers")
        expected = {
            "type": "module",
            "types": "./dist/index.d.ts",
            "exports": {".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"}},
            "files": ["dist", "LICENSE", "README.md"],
        }
        problems += [
            f"library `{key}` must equal {value!r}"
            for key, value in expected.items()
            if manifest.get(key) != value
        ]
        return problems
    extensions = parsed.pi.extensions
    if not extensions:
        problems.append("`pi.extensions` is empty")
    problems += [
        f"`pi.extensions` entry '{entry}' is not in the tarball"
        for entry in extensions
        if PurePosixPath(entry).as_posix().removeprefix("./") not in expected_files
    ]
    return problems


class FileImports(BaseModel):
    model_config = STRICT_MODEL
    specifiers: list[str] = Field(description="Every literal module specifier, in source order")
    diagnostics: list[str] = Field(
        description="`file:line:col: message` for syntax errors and computed specifiers"
    )


class ImportScan(BaseModel):
    model_config = STRICT_MODEL
    files: dict[str, FileImports] = Field(description="Parse results by path relative to the package root")


def scan_imports(sources: Mapping[str, str], node: Path) -> dict[str, FileImports]:
    """Parse JS/TS sources with the installed TypeScript parser in one batched `node` run.

    Parameters:
        sources (Mapping[str, str]): File text by path relative to the package root.
        node (Path): Absolute `node` path.

    Returns:
        dict[str, FileImports]: Specifiers and diagnostics for every input path.

    Raises:
        ContractError: If a path is unsafe, the helper fails, or its output is malformed.
    """
    if not sources:
        return {}
    for name in sources:
        pure = PurePosixPath(name)
        if pure.is_absolute() or ".." in pure.parts or not pure.parts:
            raise ContractError(f"Unsafe source path for the import audit: '{name}'")
    with tempfile.TemporaryDirectory(prefix="import-audit-") as scratch:
        root = Path(scratch)
        for name, text in sources.items():
            target = root / IMPORT_AUDIT_DIR / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        argv = [node, IMPORT_AUDIT, root, *(f"{IMPORT_AUDIT_DIR}/{name}" for name in sources)]
        env = {"PATH": os.pathsep.join([str(node.parent), "/usr/bin", "/bin"]), "HOME": str(root)}
        done = run(argv, env=env, cwd=root, timeout=IMPORT_AUDIT_TIMEOUT_S)
    try:
        scan = ImportScan.model_validate_json(done.stdout)
    except ValidationError as e:
        raise ContractError(f"Malformed `import_audit.ts` output: {e}") from e
    prefix = f"{IMPORT_AUDIT_DIR}/"
    found = {
        name.removeprefix(prefix): FileImports(
            specifiers=imports.specifiers,
            diagnostics=[problem.removeprefix(prefix) for problem in imports.diagnostics],
        )
        for name, imports in scan.files.items()
    }
    if found.keys() != sources.keys():
        raise ContractError(f"`import_audit.ts` returned {sorted(found)} for {sorted(sources)}")
    return found


def classify_imports(
    path: str,
    found: FileImports,
    files: Sequence[str],
    dependencies: Collection[str] = (),
    standalone_artifacts: Collection[str] = (),
    *,
    library: bool = False,
) -> list[str]:
    """Classify the parsed imports of one packed source file.

    Allowed: Node builtins (`node:` prefix), host-provided Pi modules, the contract's declared runtime
    dependencies, and relative paths that stay inside the package. Everything else, including any
    `@nredd/` sibling and any specifier the parser could not resolve to a literal, is a violation.
    The one sibling exception is an exact `SHARED_LIBRARIES` specifier that is also a declared
    dependency of a non-library, non-standalone file.
    Files in `standalone_artifacts` (the bundled stats `dist/` artifact) may import `node:` builtins
    only; relative imports are forbidden too, because it is copied alone.

    Parameters:
        path (str): File path relative to the package root.
        found (FileImports): Parser output for the file.
        files (Sequence[str]): All tarball paths, to resolve relative imports.
        dependencies (Collection[str]): Declared runtime dependency names that may be imported.
        library (bool): Forbid host imports, retaining relative and Node builtin imports.
        standalone_artifacts (Collection[str]): Files permitted to import only `node:` builtins.

    Returns:
        list[str]: Violations; empty when every import is acceptable.
    """
    problems = list(found.diagnostics)
    standalone = path in standalone_artifacts
    host_modules = () if library else HOST_MODULES
    for spec in found.specifiers:
        if spec.startswith("node:"):
            continue
        if spec.startswith(SIBLING_SCOPE):
            if library or standalone or spec not in SHARED_LIBRARIES or spec not in dependencies:
                problems.append(f"{path}: imports sibling plugin '{spec}'")
        elif standalone:
            problems.append(
                f"{path}: standalone artifact imports '{spec}', only `node:` builtins are allowed"
            )
        elif spec.startswith("."):
            target = PurePosixPath(os.path.normpath(PurePosixPath(path).parent / spec)).as_posix()
            stem = PurePosixPath(target).with_suffix("").as_posix()
            if target.startswith("..") or not any(
                f == target or PurePosixPath(f).with_suffix("").as_posix() == stem for f in files
            ):
                problems.append(f"{path}: relative import '{spec}' leaves the package or is missing")
        elif spec not in {*host_modules, *dependencies} and not any(
            spec.startswith(f"{module}/") for module in (*host_modules, *dependencies)
        ):
            problems.append(
                f"{path}: imports '{spec}', which is neither a Node builtin nor a host module "
                "(or declared dependency)"
            )
    return problems


def audit_imports(
    path: str,
    source: str,
    files: Sequence[str],
    node: Path | None = None,
    standalone_artifacts: Collection[str] = (),
) -> list[str]:
    """Parse and classify the imports of one source text.

    Parameters:
        path (str): File path relative to the package root.
        source (str): File text.
        files (Sequence[str]): All tarball paths, to resolve relative imports.
        node (Path | None): Absolute `node` path; resolved from `PATH` when `None`.
        standalone_artifacts (Collection[str]): Files permitted to import only `node:` builtins.

    Returns:
        list[str]: Violations; empty when every import is acceptable.
    """
    found = scan_imports({path: source}, node or locate_executable("node"))[path]
    return classify_imports(path, found, files, standalone_artifacts=standalone_artifacts)


def audit_tarball(artifact: PackedArtifact, root_license: bytes, node: Path | None = None) -> list[str]:
    """Run every static tarball audit.

    Parameters:
        artifact (PackedArtifact): Tarball to audit.
        root_license (bytes): Content of the repository `LICENSE`.
        node (Path | None): Absolute `node` path for the import audit; resolved from `PATH` when `None`.

    Returns:
        list[str]: All violations found.
    """
    contract = artifact.contract
    problems = audit_files(contract, artifact.files)
    expected_license = (
        (REPO_ROOT / "packages" / contract.directory / "LICENSE").read_bytes()
        if contract.own_license
        else root_license
    )
    problems += audit_license(artifact.path, expected_license)
    try:
        manifest = json.loads(read_member(artifact.path, "package.json"))
    except (ContractError, ValueError) as e:
        problems.append(f"packed `package.json` is not valid JSON: {e}")
    else:
        problems += audit_manifest(contract, manifest, artifact.files)
    sources = {
        name: read_member(artifact.path, name).decode()
        for name in artifact.files
        if name.endswith(CODE_SUFFIXES)
    }
    scanned = scan_imports(sources, node or locate_executable("node"))
    for name, found in scanned.items():
        problems += classify_imports(
            name,
            found,
            artifact.files,
            [dependency for dependency, _ in contract.runtime_dependencies],
            contract.standalone_artifacts,
            library=contract.library,
        )
    if contract.packed_patterns:
        problems += audit_chunk_graph(contract, artifact.files, scanned)
    return problems


# --- install --------------------------------------------------------------------------------------


# Metadata npm itself writes into `node_modules` (verified against a real install): not packages.
NPM_MODULE_METADATA = frozenset({".bin", ".package-lock.json"})
SEMVER_CHECK = (
    "const semver = require(process.argv[1]);"
    "const items = JSON.parse(process.argv[2]);"
    "console.log(JSON.stringify(items.map(([version, range]) => semver.satisfies(version, range))));"
)


@dataclass(frozen=True)
class InstalledPackage:
    """Runtime dependency edges read from one installed `package.json`.

    Parameters:
        version (str | None): The installed `version`, when it is a string.
        runtime_edges (dict[str, str]): Combined runtime edges, `optionalDependencies` merged with
            `dependencies` (what npm may install for this package), NOT the `dependencies` field alone.
        optional (frozenset[str]): Names only in `optionalDependencies`, which npm may legitimately skip.
    """

    version: str | None
    runtime_edges: dict[str, str]
    optional: frozenset[str]


def is_npm_metadata(path: Path, name: str, prefix: str) -> bool:
    """Validate an npm-created metadata entry and report whether it needs no further auditing.

    Parameters:
        path (Path): Installed entry to inspect.
        name (str): Entry basename.
        prefix (str): Lockfile-style parent directory.

    Returns:
        bool: Whether this is a validated metadata entry exempt from package auditing.

    Raises:
        ContractError: If a recognized metadata entry has an unsafe shape.
    """
    if name not in NPM_MODULE_METADATA:
        return False
    if name == ".package-lock.json":
        valid = prefix == "node_modules" and not path.is_symlink() and path.is_file()
    else:
        valid = (
            not path.is_symlink()
            and path.is_dir()
            and all(member.is_symlink() or member.is_file() for member in path.iterdir())
        )
    if not valid:
        raise ContractError(f"Invalid npm metadata entry '{prefix}/{name}'")
    return True


def nested_installed_entries(directory: Path, path: str) -> list[tuple[Path, str, bool]]:
    """Walk a package's nested `node_modules`, rejecting a symlinked directory.

    Parameters:
        directory (Path): Installed package directory.
        path (str): Lockfile-style package path.

    Returns:
        list[tuple[Path, str, bool]]: Nested entries with paths and scope-directory markers.

    Raises:
        ContractError: If the nested node_modules directory is symlinked.
    """
    nested = directory / "node_modules"
    if nested.is_symlink():
        raise ContractError(f"Symlinked `node_modules` entry is not allowed: '{path}/node_modules'")
    return walk_installed_entries(nested, f"{path}/node_modules") if nested.is_dir() else []


def walk_installed_entries(modules: Path, prefix: str = "node_modules") -> list[tuple[Path, str, bool]]:
    """Walk package-shaped entries while validating npm's limited metadata exemptions.

    Parameters:
        modules (Path): A `node_modules` directory.
        prefix (str): Lockfile-style path of `modules`.

    Returns:
        list[tuple[Path, str, bool]]: `(path, lockfile path, is_scope)` entries.

    Raises:
        ContractError: If an entry is a symlink or npm metadata is malformed.
    """
    entries: list[tuple[Path, str, bool]] = []
    for child in sorted(modules.iterdir()):
        path = f"{prefix}/{child.name}"
        if is_npm_metadata(child, child.name, prefix):
            continue
        if child.is_symlink():
            raise ContractError(f"Symlinked `node_modules` entry is not allowed: '{path}'")
        if child.name.startswith("@") and child.is_dir():
            entries.append((child, path, True))
            for member in sorted(child.iterdir()):
                member_path = f"{path}/{member.name}"
                if member.is_symlink():
                    raise ContractError(f"Symlinked `node_modules` entry is not allowed: '{member_path}'")
                entries.append((member, member_path, False))
                entries.extend(nested_installed_entries(member, member_path))
            continue
        entries.append((child, path, False))
        entries.extend(nested_installed_entries(child, path))
    return entries


def read_installed_packages(modules: Path, prefix: str = "node_modules") -> dict[str, InstalledPackage]:
    """Read every installed package under `modules`, including nested `node_modules`.

    Directories without a `package.json` are skipped here; `list_installed_entries` accounts for them.

    Parameters:
        modules (Path): A `node_modules` directory.
        prefix (str): Lockfile-style path of `modules`.

    Returns:
        dict[str, InstalledPackage]: Packages by `node_modules/...` path.

    Raises:
        ContractError: If an installed `package.json` is not a JSON object with maps for its dependency
            fields and a `name` equal to the one its path implies.
    """
    found: dict[str, InstalledPackage] = {}
    for directory, path, is_scope in walk_installed_entries(modules, prefix):
        if is_scope:
            continue
        manifest_path = directory / "package.json"
        if not directory.is_dir() or not manifest_path.is_file():
            continue
        try:
            manifest = json.loads(manifest_path.read_text())
        except ValueError as e:
            raise ContractError(f"Installed '{path}/package.json' is not valid JSON: {e}") from e
        if not isinstance(manifest, dict):
            raise ContractError(f"Installed '{path}/package.json' is not an object")
        implied = path.rsplit("node_modules/", 1)[1]
        if manifest.get("name") != implied:
            raise ContractError(
                f"Installed '{path}/package.json' is named {manifest.get('name')!r}, not '{implied}'"
            )
        dependencies = manifest.get("dependencies") or {}
        optional = manifest.get("optionalDependencies") or {}
        if not isinstance(dependencies, dict) or not isinstance(optional, dict):
            raise ContractError(f"Installed '{path}/package.json' has malformed dependency maps")
        version = manifest.get("version")
        found[path] = InstalledPackage(
            version if isinstance(version, str) else None,
            {**optional, **dependencies},
            frozenset(optional) - set(dependencies),
        )
    return found


def list_installed_entries(modules: Path, prefix: str = "node_modules") -> tuple[set[str], set[str]]:
    """List every entry under every `node_modules`, manifest or not.

    Parameters:
        modules (Path): A `node_modules` directory.
        prefix (str): Lockfile-style path of `modules`.

    Returns:
        tuple[set[str], set[str]]: Package-shaped entry paths (files included, scope directories
            excluded) and scope directory paths, both lockfile-style.
    """
    walked = walk_installed_entries(modules, prefix)
    return (
        {path for _, path, is_scope in walked if not is_scope},
        {path for _, path, is_scope in walked if is_scope},
    )


def audit_ranges(checks: Sequence[tuple[str, str, str]], node: Path) -> list[str]:
    """Check installed versions against declared npm ranges with the repository's `semver` package.

    Parameters:
        checks (Sequence[tuple[str, str, str]]): `(name, installed version, declared range)` triples.
        node (Path): Absolute `node` path.

    Returns:
        list[str]: Violations; empty when every version satisfies its range.

    Raises:
        ContractError: If `semver` is not installed or the helper output is malformed.
    """
    if not checks:
        return []
    semver = REPO_ROOT / "node_modules" / "semver"
    require(semver.is_dir(), f"`semver` is not installed at {semver}; run `npm ci`")
    env = {"PATH": os.pathsep.join([str(node.parent), "/usr/bin", "/bin"]), "HOME": str(REPO_ROOT)}
    payload = json.dumps([[version, spec] for _, version, spec in checks])
    done = run(
        [node, "-e", SEMVER_CHECK, semver, payload], env=env, cwd=REPO_ROOT, timeout=IMPORT_AUDIT_TIMEOUT_S
    )
    try:
        verdicts = json.loads(done.stdout)
    except ValueError as e:
        raise ContractError(f"Malformed `semver` output: {done.stdout!r}") from e
    if not isinstance(verdicts, list) or len(verdicts) != len(checks):
        raise ContractError(f"Malformed `semver` output: {done.stdout!r}")
    return [
        f"installed '{name}' {version} does not satisfy '{spec}'"
        for (name, version, spec), ok in zip(checks, verdicts, strict=True)
        if ok is not True
    ]


def resolve_dependency(parent: str, name: str, installed: Mapping[str, object]) -> str | None:
    """Resolve `name` from `parent` the way npm does: nearest enclosing `node_modules` first.

    Parameters:
        parent (str): Requiring package path, e.g. `node_modules/a/node_modules/b`.
        name (str): Dependency name.
        installed (Mapping[str, object]): Installed package paths.

    Returns:
        str | None: The installed path, or `None` when nothing satisfies it.
    """
    current = parent
    while True:
        candidate = f"{current}/node_modules/{name}" if current else f"node_modules/{name}"
        if candidate in installed:
            return candidate
        if not current:
            return None
        current = current.rsplit("/node_modules/", 1)[0] if "/node_modules/" in current else ""


def is_skipped_optional(
    path: str, closure: Collection[str], installed: Mapping[str, InstalledPackage]
) -> bool:
    """Whether a lock-only `path` is an optional dependency npm legitimately skipped.

    npm writes platform-mismatched optional dependencies to the lock as `optional: true` without
    installing them. The caller checks the lock flag; this checks a closure member lists the name in
    `optionalDependencies` at or below the directory the lock path hangs from.

    Parameters:
        path (str): Lock-only `node_modules/...` path.
        closure (Collection[str]): Derived closure paths (the empty root path is ignored).
        installed (Mapping[str, InstalledPackage]): Installed packages by path.

    Returns:
        bool: `True` when an installed requirer declares it optional.
    """
    name = path.rsplit("node_modules/", 1)[1]
    parent = path[: -len(f"node_modules/{name}")].rstrip("/")
    return any(
        name in installed[requirer].optional
        and (not parent or requirer == parent or requirer.startswith(f"{parent}/"))
        for requirer in closure
        if requirer
    )


def derive_closure(root: str, installed: Mapping[str, InstalledPackage]) -> set[str]:
    """Derive the runtime dependency closure of `root` from installed manifests alone.

    Parameters:
        root (str): Installed package path to start from.
        installed (Mapping[str, InstalledPackage]): Installed packages by path.

    Returns:
        set[str]: `root` plus every transitively required installed path.

    Raises:
        ContractError: If a required (non-optional) dependency is not installed.
    """
    closure = {root}
    pending = [root]
    while pending:
        parent = pending.pop()
        entry = installed[parent]
        for name in entry.runtime_edges:
            child = resolve_dependency(parent, name, installed)
            if child is None:
                if name in entry.optional:
                    continue
                raise ContractError(f"'{parent}' requires '{name}', which is not installed")
            if child not in closure:
                closure.add(child)
                pending.append(child)
    return closure


def audit_install_closure(
    contract: PackageContract, project: Path, lock: LockFile, top: Sequence[str]
) -> None:
    """Prove an install is exactly the closure derived from its installed manifests.

    Parameters:
        contract (PackageContract): Installed package contract.
        project (Path): Consumer project root.
        lock (LockFile): Parsed install lockfile.
        top (Sequence[str]): Sorted top-level `node_modules` entry names.

    Raises:
        ContractError: If the package, its manifests, versions, lock paths or any `node_modules` entry
            differs from the derived closure.
    """
    package_path = f"node_modules/{contract.name}"
    declared_dependencies = dict(contract.runtime_dependencies)
    installed_packages = read_installed_packages(project / "node_modules")
    if package_path not in installed_packages:
        raise ContractError(f"'{contract.name}' is absent from `node_modules`")
    if installed_packages[package_path].runtime_edges != declared_dependencies:
        raise ContractError(
            f"'{contract.name}' installed dependencies differ from its contract: "
            f"{installed_packages[package_path].runtime_edges} != {declared_dependencies}"
        )
    expected_paths = {"", *derive_closure(package_path, installed_packages)}
    actual_paths = set(lock.packages)
    optional_skipped = {
        path
        for path in actual_paths - expected_paths
        if lock.packages[path].optional and is_skipped_optional(path, expected_paths, installed_packages)
    }
    if actual_paths - optional_skipped != expected_paths:
        raise ContractError(
            f"'{contract.name}' lockfile paths differ from the installed dependency closure: "
            f"expected {sorted(expected_paths)}, got {sorted(actual_paths)}"
        )
    installed_paths = {"", *installed_packages}
    if installed_paths != expected_paths:
        raise ContractError(
            f"'{contract.name}' installed packages differ from the dependency closure: "
            f"expected {sorted(expected_paths)}, got {sorted(installed_paths)}"
        )
    expected_top = sorted({path.split("/")[1] for path in expected_paths if path})
    if top != expected_top:
        raise ContractError(f"'{contract.name}' install entries differ: expected {expected_top}, got {top}")
    entries, scopes = list_installed_entries(project / "node_modules")
    stray = sorted(entries - expected_paths)
    stray += sorted(
        scope for scope in scopes if not any(path.startswith(f"{scope}/") for path in expected_paths)
    )
    if stray:
        raise ContractError(f"'{contract.name}' install has entries outside the closure: {stray}")
    checks: list[tuple[str, str, str]] = []
    for parent in expected_paths - {""}:
        for name, spec in installed_packages[parent].runtime_edges.items():
            resolved = resolve_dependency(parent, name, installed_packages)
            if resolved is None and name in installed_packages[parent].optional:
                continue
            version = installed_packages[resolved].version if resolved else None
            if version is None:
                raise ContractError(f"Installed '{name}' has no resolvable version")
            checks.append((name, version, spec))
    problems = audit_ranges(checks, locate_executable("node"))
    if problems:
        raise ContractError(f"'{contract.name}' dependency versions: {problems}")


def install_alone(artifact: PackedArtifact, sandbox: Sandbox, project: Path) -> Path:
    """Install one tarball into an empty project and prove no host or sibling copy came along.

    A dependency-free package must be the only entry. Otherwise the allowed set is the closure derived
    independently from each INSTALLED `node_modules/**/package.json` (`dependencies` plus
    `optionalDependencies`, resolved npm-style by walking up from the requirer's `node_modules`), never
    from the lockfile. That closure must equal the lockfile paths, every installed package path and the
    top-level `node_modules` entries exactly.

    Parameters:
        artifact (PackedArtifact): Tarball to install.
        sandbox (Sandbox): Environment for `npm`.
        project (Path): New, empty project directory.

    Returns:
        Path: The installed package directory.

    Raises:
        ContractError: If the package is missing or ships a nested `node_modules`; its installed or
            locked dependencies differ from the contract; a required dependency is not installed; or the
            lockfile paths, installed packages or top-level entries differ from the derived closure.
    """
    project.mkdir(parents=True)
    (project / "package.json").write_text('{"name": "contract-consumer", "private": true}\n')
    env = sandbox.env()
    offline = ["--offline"]
    if artifact.contract.runtime_dependencies:
        # Declared runtime dependencies come from the registry; plugins stay fully offline.
        env = env | REGISTRY_ENV
        offline = []
    run(
        [
            sandbox.tools.npm,
            "install",
            "--ignore-scripts",
            "--legacy-peer-deps",
            *offline,
            "--no-audit",
            "--no-fund",
            artifact.path,
        ],
        env=env,
        cwd=project,
        timeout=NPM_TIMEOUT_S,
    )
    installed = project / "node_modules" / artifact.contract.name
    top = sorted(p.name for p in (project / "node_modules").iterdir() if p.name not in NPM_MODULE_METADATA)
    nested = [p for p in installed.rglob("node_modules") if p.is_dir()]
    if nested:
        raise ContractError(f"'{artifact.contract.name}' ships a nested `node_modules`: {nested}")
    lock = read_lockfile(project / "package-lock.json")
    package_path = f"node_modules/{artifact.contract.name}"
    package_entry = lock.packages.get(package_path)
    if package_entry is None:
        raise ContractError(f"'{artifact.contract.name}' is absent from its install lockfile")
    declared_dependencies = dict(artifact.contract.runtime_dependencies)
    if package_entry.dependencies != declared_dependencies:
        raise ContractError(
            f"'{artifact.contract.name}' lockfile dependencies differ from its contract: "
            f"{package_entry.dependencies} != {declared_dependencies}"
        )
    audit_install_closure(artifact.contract, project, lock, top)
    return installed


# --- stock Pi runs --------------------------------------------------------------------------------


@dataclass(frozen=True)
class PiRun:
    """Result of one stock Pi invocation in JSON mode.

    Parameters:
        returncode (int): Process exit code.
        events (tuple[dict[str, Any], ...]): Parsed stdout JSONL records.
        stdout (str): Raw stdout.
        stderr (str): Raw stderr.
    """

    returncode: int
    events: tuple[dict[str, Any], ...]
    stdout: str
    stderr: str

    def tool_results(self, name: str) -> list[dict[str, Any]]:
        """Return `tool_execution_end` records for one tool, in order.

        Parameters:
            name (str): Tool name.

        Returns:
            list[dict[str, Any]]: Matching records.
        """
        return [e for e in self.events if e.get("type") == "tool_execution_end" and e.get("toolName") == name]

    def assistant_messages(self) -> list[dict[str, Any]]:
        """Return finished assistant messages in order.

        Returns:
            list[dict[str, Any]]: `message_end` payloads with role `assistant`.

        Raises:
            ContractError: If a `message_end` event has no object `message`.
        """
        found: list[dict[str, Any]] = []
        for event in self.events:
            if event.get("type") != "message_end":
                continue
            try:
                parsed = MessageEndEvent.model_validate(event)
            except ValidationError as e:
                raise ContractError(f"Malformed `message_end` event: {describe_validation(e)}") from e
            if parsed.message.role == "assistant":
                found.append(event["message"])
        return found

    def single_tool_result(self, name: str) -> dict[str, Any]:
        """Return the one `tool_execution_end` record for a tool.

        Parameters:
            name (str): Tool name.

        Returns:
            dict[str, Any]: The record.

        Raises:
            ContractError: If the tool did not finish exactly once.
        """
        records = self.tool_results(name)
        if len(records) != 1:
            raise ContractError(f"Expected exactly one `{name}` result, got {len(records)}")
        return records[0]


def tool_text(record: dict[str, Any]) -> str:
    """Join the text blocks of a tool result record.

    Parameters:
        record (dict[str, Any]): A `tool_execution_end` event.

    Returns:
        str: Concatenated text content.

    Raises:
        ContractError: If the record has no well-formed `result.content`.
    """
    return "".join(block.text for block in parse_tool_record(record).result.content if block.type == "text")


def parse_tool_record(record: dict[str, Any]) -> ToolRecord:
    """Validate the consumed part of a `tool_execution_end` event.

    Parameters:
        record (dict[str, Any]): A `tool_execution_end` event.

    Returns:
        ToolRecord: Its result payload.

    Raises:
        ContractError: If `result` or `result.content` is missing or mistyped.
    """
    try:
        return ToolRecord.model_validate(record)
    except ValidationError as e:
        raise ContractError(
            f"Malformed tool result for '{record.get('toolName')}': {describe_validation(e)}"
        ) from e


def tool_is_error(record: dict[str, Any]) -> bool:
    """Read a tool record's `isError` flag, which must be a real boolean.

    Parameters:
        record (dict[str, Any]): A `tool_execution_end` event.

    Returns:
        bool: Whether the tool reported failure.

    Raises:
        ContractError: If `isError` is missing or not a boolean.
    """
    try:
        return ToolOutcome.model_validate(record).isError
    except ValidationError as e:
        raise ContractError(
            f"Malformed tool result for '{record.get('toolName')}': {describe_validation(e)}"
        ) from e


def parse_events(stdout: str) -> tuple[dict[str, Any], ...]:
    """Parse Pi's strict LF-framed JSONL stream.

    Parameters:
        stdout (str): Raw stdout.

    Returns:
        tuple[dict[str, Any], ...]: One object per record.

    Raises:
        ContractError: If a record is not a JSON object.
    """
    events: list[dict[str, Any]] = []
    for line in stdout.split("\n"):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as e:
            raise ContractError(f"Non-JSON line in Pi JSON mode: '{line[:200]}'") from e
        if not isinstance(event, dict):
            raise ContractError(f"Non-object record in Pi JSON mode: '{line[:200]}'")
        events.append(event)
    return tuple(events)


def run_pi(
    pi_bin: Path,
    sandbox: Sandbox,
    package_dir: Path,
    cwd: Path,
    extra: Sequence[str],
    *,
    session_dir: Path | None = None,
    trust: Literal["approve", "no-approve"] = "no-approve",
) -> PiRun:
    """Run stock Pi non-interactively with exactly one package loaded.

    Only safe, documented flags: `--offline`, `--no-mcp`, `--no-extensions` (with an explicit `--extension`),
    `--no-skills`, `--no-prompt-templates`, `--no-themes`, `--no-context-files`, and one explicit
    project-trust decision (`--no-approve` unless `trust` says otherwise).

    Parameters:
        pi_bin (Path): Stock `pi`.
        sandbox (Sandbox): Scrubbed environment.
        package_dir (Path): Installed package directory to load.
        cwd (Path): Working directory for the run.
        extra (Sequence[str]): Remaining arguments (model, mode, prompt).
        session_dir (Path | None): Persist the session here; `None` keeps it in memory.
        trust (Literal["approve", "no-approve"]): One-time project-trust decision (`--approve` or
            `--no-approve`); Pi then never consults or writes a saved decision.

    Returns:
        PiRun: Exit code, parsed events and raw streams.
    """
    session = ["--session-dir", str(session_dir)] if session_dir else ["--no-session"]
    argv = [
        pi_bin,
        "--offline",
        f"--{trust}",
        "--no-mcp",
        "--no-extensions",
        "--extension",
        package_dir,
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        *session,
        *extra,
    ]
    done = run(argv, env=sandbox.env(), cwd=cwd, timeout=PI_TIMEOUT_S, check=False)
    return PiRun(
        done.returncode, parse_events(done.stdout) if "--mode" in extra else (), done.stdout, done.stderr
    )


def require(condition: bool, message: str) -> None:
    """Raise `ContractError` unless `condition` holds.

    Parameters:
        condition (bool): Predicate that must be true.
        message (str): Failure description.

    Raises:
        ContractError: When `condition` is false.
    """
    if not condition:
        raise ContractError(message)


def require_clean_run(result: PiRun, what: str) -> None:
    """Require a successful Pi run with no extension errors or stray diagnostics.

    Parameters:
        result (PiRun): The run.
        what (str): Description for failure messages.

    Raises:
        ContractError: On a nonzero exit or any stderr output.
    """
    require(result.returncode == 0, f"{what}: pi exited {result.returncode}\n{result.stderr[-2000:]}")
    require(not result.stderr.strip(), f"{what}: unexpected stderr\n{result.stderr[-2000:]}")


def require_tools(
    result: PiRun,
    contract: PackageContract,
    siblings: Sequence[PackageContract],
    requests: Sequence[RecordedRequest],
    *,
    all_tools: bool = False,
) -> None:
    """Require the package's tools declared to the model and no sibling's.

    Parameters:
        result (PiRun): The run, for context in messages.
        contract (PackageContract): Package under test.
        siblings (Sequence[PackageContract]): Every other package.
        requests (Sequence[RecordedRequest]): Requests seen by the provider.
        all_tools (bool): Require every tool in `contract.exposes_tools`, not just one of them.

    Raises:
        ContractError: If an expected tool is missing or a sibling's tool is present.
    """
    require(bool(requests), f"{contract.name}: the provider received no request\n{result.stderr[-500:]}")
    declared = set(requests[0].tools)
    present = contract.exposes_tools & declared
    require(
        bool(present),
        f"{contract.name}: none of {sorted(contract.exposes_tools)} declared; got {sorted(declared)}",
    )
    missing = contract.exposes_tools - declared
    require(
        not (all_tools and missing),
        f"{contract.name}: tools not offered to the model: {sorted(missing)}; got {sorted(declared)}\n"
        f"{result.stderr[-1000:]}",
    )
    foreign = declared & {tool for other in siblings for tool in other.exposes_tools}
    require(not foreign, f"{contract.name}: sibling tools present without the sibling: {sorted(foreign)}")


@dataclass(frozen=True)
class Context:
    """Everything a standalone scenario needs.

    Parameters:
        pi_bin (Path): Stock `pi`.
        sandbox (Sandbox): Scrubbed environment.
        installed (Path): Installed package directory.
        artifact (PackedArtifact): Tarball identity.
        work (Path): Scenario scratch directory.
        siblings (tuple[PackageContract, ...]): Other packages' contracts.
    """

    pi_bin: Path
    sandbox: Sandbox
    installed: Path
    artifact: PackedArtifact
    work: Path
    siblings: tuple[PackageContract, ...]

    def provider_session(self, script: Sequence[Step], routes: Sequence[Route] = ()) -> FauxProvider:
        """Write `models.json` for a loopback provider running `script`.

        Parameters:
            script (Sequence[Step]): Scripted turns.
            routes (Sequence[Route]): Alternative scripts for conversations carrying a marker.

        Returns:
            FauxProvider: Provider to use as a context manager around the Pi run.
        """
        provider = FauxProvider(script, routes)
        (self.sandbox.agent_dir / "models.json").write_text(
            models_json(provider.base_url, PROVIDER, (PHYSICAL_MODEL,))
        )
        return provider

    def git(self, repo: Path, *args: str) -> None:
        """Run `git` in a disposable repository.

        Parameters:
            repo (Path): Repository directory.
            *args (str): Git arguments.
        """
        run([self.sandbox.tools.git, "-C", repo, *args], env=self.sandbox.env(), cwd=repo, timeout=60)


def scenario_dev_tools(ctx: Context) -> DevToolsEvidence:
    """Real `git_status` result, and its failure path, through stock Pi.

    Parameters:
        ctx (Context): Scenario context.

    Returns:
        DevToolsEvidence: Evidence recorded in the report.

    Raises:
        ContractError: If the tool misbehaves.
    """
    repo = ctx.work / "repo"
    repo.mkdir()
    ctx.git(repo, "init", "-q", "-b", "main")
    (repo / "untracked.txt").write_text("x\n")
    script = [ToolStep("git_status"), TextStep("done")]
    with ctx.provider_session(script) as provider:
        ok = run_pi(
            ctx.pi_bin,
            ctx.sandbox,
            ctx.installed,
            repo,
            ["--model", f"{PROVIDER}/{PHYSICAL_MODEL}", "--mode", "json", "go"],
        )
    require_clean_run(ok, "dev-tools git_status")
    require_tools(ok, ctx.artifact.contract, ctx.siblings, provider.requests)
    record = ok.single_tool_result("git_status")
    require(not tool_is_error(record), f"git_status failed: {tool_text(record)}")
    structured = parse_tool_record(record).result.structuredContent
    require(
        structured is not None and structured.get("untracked") == ["untracked.txt"],
        f"unexpected status: {record.get('result')}",
    )

    not_repo = ctx.work / "not-a-repo"
    not_repo.mkdir()
    with ctx.provider_session(script):
        bad = run_pi(
            ctx.pi_bin,
            ctx.sandbox,
            ctx.installed,
            not_repo,
            ["--model", f"{PROVIDER}/{PHYSICAL_MODEL}", "--mode", "json", "go"],
        )
    require_clean_run(bad, "dev-tools git_status outside a repository")
    failed = bad.single_tool_result("git_status")
    require(
        tool_is_error(failed),
        f"git_status outside a repository must be an error result: {failed.get('result')}",
    )
    ranking, resource_failure = exercise_resource_snapshot(ctx)
    return {
        "tool": "git_status",
        "untracked": ["untracked.txt"],
        "failure_path": tool_text(failed)[:200],
        "resource_ranking": ranking,
        "resource_sampler_integrity": installed_sampler_integrity(
            ctx.installed, published_sampler_dist(ctx.sandbox, ctx.work)
        ),
        "resource_failure_path": resource_failure[:200],
    }


def redact_url(url: str | None) -> str:
    """Drop credentials, query and fragment from a URL before it reaches an error or report.

    Parameters:
        url (str | None): URL from a lockfile or registry response.

    Returns:
        str: `scheme://host[:port]/path`, or a placeholder when absent or unparseable.
    """
    if not url:
        return "<missing>"
    try:
        parts = urlsplit(url)
        host = parts.hostname or ""
        port = f":{parts.port}" if parts.port is not None else ""
    except ValueError:
        return "<unparseable>"
    return f"{parts.scheme}://{host}{port}{parts.path}"


def published_sampler_dist(sandbox: Sandbox, cwd: Path) -> PublishedDist:
    """Ask the public registry for the exact sampler release's tarball URL and integrity.

    Runs with the scrubbed sandbox environment (no npm credentials) and no proxy.

    Parameters:
        sandbox (Sandbox): Environment and tools for `npm`.
        cwd (Path): Scratch directory without an `.npmrc`.

    Returns:
        PublishedDist: Registry metadata for `RESOURCE_SAMPLER_VERSION`.

    Raises:
        ContractError: If the query fails or the response is malformed.
    """
    spec = f"{RESOURCE_SAMPLER_CONTRACT.name}@{RESOURCE_SAMPLER_VERSION}"
    done = run(
        [sandbox.tools.npm, "view", spec, "dist", "--json"],
        env=sandbox.env() | REGISTRY_ENV,
        cwd=cwd,
        timeout=NPM_TIMEOUT_S,
    )
    try:
        return PublishedDist.model_validate_json(done.stdout)
    except ValidationError as e:
        raise ContractError(f"Registry metadata for '{spec}' is malformed: {e}") from e


def installed_sampler_integrity(installed: Path, published: PublishedDist) -> str:
    """Prove the installed plugin resolves the exact published sampler from the registry.

    The lock entry must name the registry's own tarball URL and integrity for that version, not merely
    carry some integrity.

    Parameters:
        installed (Path): Installed `@nredd/pi-dev-tools` directory inside `<project>/node_modules`.
        published (PublishedDist): Registry metadata for the pinned version.

    Returns:
        str: The verified registry integrity.

    Raises:
        ContractError: If the sampler is linked, missing, another version, or locked to other bytes or origin.
    """
    name, version = RESOURCE_SAMPLER_CONTRACT.name, RESOURCE_SAMPLER_VERSION
    project = installed.parents[2]
    module = project / "node_modules" / name
    require(module.is_dir() and not module.is_symlink(), f"'{name}' is not a real installed directory")
    entry = read_lockfile(project / "package-lock.json").packages.get(f"node_modules/{name}", LockEntry())
    require(entry.version == version, f"'{name}' is locked at {entry.version!r}, not exactly {version!r}")
    require(
        entry.resolved == published.tarball,
        f"'{name}' resolved from {redact_url(entry.resolved)}, not the published "
        f"{redact_url(published.tarball)}",
    )
    require(
        entry.integrity == published.integrity,
        f"'{name}' locked integrity {entry.integrity!r} differs from the published {published.integrity!r}",
    )
    return published.integrity


# Run from the installed plugin directory, so the specifier resolves exactly as the packed plugin's own import
# does. One full, unranked scan, then a real in-flight cancellation. Prints PIDs, coverage counters, the
# marker child's own name and whether any 12-char window of the secret appears in the scan; never other names.
SAMPLER_DISCOVERY_PROBE = """
import { fileURLToPath } from 'node:url';
import { createResourceSampler } from '@nredd/pi-resource-sampler';
const [pid, secret] = [Number(process.argv[1]), process.argv[2]];
const sampler = createResourceSampler({ maxDurationMs: 5000 });
try {
    const sample = await sampler.sample();
    const found = sample.processes.filter((entry) => entry.pid === pid);
    const text = JSON.stringify(sample);
    const leaked = Array.from({ length: secret.length - 11 }, (_, i) => secret.slice(i, i + 12))
        .some((window) => text.includes(window));
    const controller = new AbortController();
    const reason = new Error('probe cancel');
    const pending = sampler.sample(controller.signal);
    controller.abort(reason);
    const cancelled = await pending.then(
        () => 'resolved',
        (error) => (error === reason ? 'rejected' : `${error}`),
    );
    console.log(JSON.stringify({
        cancelled,
        leaked,
        resolved: fileURLToPath(import.meta.resolve('@nredd/pi-resource-sampler')),
        coverage: {
            complete: sample.coverage.complete,
            enumerated: sample.coverage.enumerated,
            sampled: sample.coverage.sampled,
            reasons: sample.coverage.reasons,
        },
        found: found.map((entry) => ({ pid: entry.pid, parentPid: entry.parentPid, name: entry.name })),
    }));
} finally {
    await sampler.dispose();
}
"""


class DiscoveredProcess(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    pid: int = Field(description="Sampled PID")
    parentPid: int = Field(description="Sampled parent PID")
    name: str = Field(description="Sampled executable basename of the marker child (never another process)")


class ScanCoverage(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    complete: bool = Field(description="True only when the scan recorded no limit or skip reason")
    enumerated: int = Field(description="Process entries encountered")
    sampled: int = Field(description="Process entries returned")
    reasons: list[str] = Field(description="Why the scan is partial, e.g. `deadline`, `pid-limit`")


class SamplerDiscovery(BaseModel):
    model_config = LENIENT_STRICT_MODEL
    resolved: NonEmptyText = Field(description="Real path the plugin directory resolves the sampler to")
    coverage: ScanCoverage = Field(description="Coverage of the scan")
    found: list[DiscoveredProcess] = Field(description="Scan entries with the marker PID")
    leaked: bool = Field(description="Whether any 12-char window of the marker secret appeared in the scan")
    cancelled: str = Field(description="`rejected` when an in-flight sample rejected with the abort reason")


def secret_windows(secret: str) -> list[str]:
    """Every 12-char window of `secret`, shorter than Linux comm (15 bytes) and Darwin `p_comm` (16 bytes).

    Parameters:
        secret (str): Marker secret.

    Returns:
        list[str]: Overlapping windows; any one in an output means a name leaked argv, title or comm.
    """
    return [secret[i : i + 12] for i in range(len(secret) - 11)]


def kernel_executable_names(node: Path) -> set[str]:
    """Names sampler 0.1.1 may report for a child exec'd from `node`, and nothing invented.

    Linux reads the `/proc/PID/exe` target, so the resolved basename. Darwin reports kinfo `p_comm`, the
    exec'd file name truncated to 16 bytes; both the invoked and resolved basenames are accepted there.

    Parameters:
        node (Path): Executable the child was started from.

    Returns:
        set[str]: Acceptable executable basenames.
    """
    resolved = node.resolve().name
    if sys.platform.startswith("linux"):
        return {resolved}
    return {name.encode()[:16].decode(errors="ignore") for name in (node.name, resolved)}


def wait_hostile_ready(child: subprocess.Popen[bytes], timeout: float) -> None:
    """Read a bounded readiness line without blocking on a silent or partial-line child.

    Parameters:
        child (subprocess.Popen[bytes]): Child with piped stdout, owned by the caller.
        timeout (float): Maximum readiness wait in seconds.

    Raises:
        ContractError: If readiness times out, stdout closes or its line is malformed.
    """
    assert child.stdout is not None
    deadline = time.monotonic() + timeout
    output = b""
    with selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        while b"\n" not in output:
            remaining = deadline - time.monotonic()
            require(remaining > 0, "hostile marker child readiness timed out")
            require(bool(selector.select(remaining)), "hostile marker child readiness timed out")
            chunk = os.read(child.stdout.fileno(), 1024)
            require(bool(chunk), "hostile marker child exited before readiness")
            output += chunk
            require(len(output) <= 1024, "hostile marker child readiness line is too long")
    require(output.split(b"\n", 1)[0] == b"ready", "hostile marker child readiness is malformed")


def stop_hostile_child(child: subprocess.Popen[bytes]) -> None:
    """Kill and reap the owned marker child within two seconds and close its pipe.

    Parameters:
        child (subprocess.Popen[bytes]): Marker child owned by this gate.

    Raises:
        subprocess.TimeoutExpired: If the exact child survives SIGKILL for two seconds.
    """
    try:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=2)
    finally:
        if child.stdout is not None:
            child.stdout.close()


@contextmanager
def start_hostile_child(
    ctx: Context,
    project: Path,
    secret: str,
    *,
    script: str = SAMPLER_HOSTILE_CHILD,
    ready_timeout: float = 5,
) -> Iterator[subprocess.Popen[bytes]]:
    """Own an idle `node` child whose argv[0], process title and Linux comm hold `secret`.

    Negative control: the sampler 0.1.0 name source (Darwin `ps -c` comm, Linux `/proc/PID/comm`) must
    really carry the secret, so a clean snapshot proves the 0.1.1 source and not an inert marker.

    Parameters:
        ctx (Context): Scenario context.
        project (Path): Working directory.
        secret (str): Random marker secret.
        script (str): Child script, injectable for real startup-failure tests.
        ready_timeout (float): Maximum startup wait in seconds.

    Yields:
        subprocess.Popen[bytes]: The running child, reaped on startup failure or context exit.

    Raises:
        ContractError: If the child does not start or the legacy source does not show the secret.
        BaseExceptionGroup: If startup or the caller's body and cleanup both fail.
        subprocess.TimeoutExpired: If cleanup alone fails to reap the child within two seconds.
    """
    child = subprocess.Popen(
        [secret, "-e", script],
        executable=str(ctx.sandbox.tools.node),
        env=ctx.sandbox.env() | {"S": secret},
        cwd=project,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_hostile_ready(child, ready_timeout)
        if sys.platform.startswith("linux"):
            legacy = Path(f"/proc/{child.pid}/comm").read_text().strip() == secret[:15]
        else:
            ps = run(
                [Path("/bin/ps"), "-c", "-o", "comm=", "-p", str(child.pid)],
                env={"LC_ALL": "C", "PATH": "/usr/bin:/bin"},
                cwd=ctx.work,
                timeout=30,
            )
            legacy = secret in ps.stdout
        require(legacy, "hostile marker child does not expose its secret through the 0.1.0 name source")
        yield child
    except BaseException as primary:
        try:
            stop_hostile_child(child)
        except BaseException as cleanup:
            raise BaseExceptionGroup("marker child and cleanup failed", [primary, cleanup]) from primary
        raise
    else:
        stop_hostile_child(child)


def discover_child_with_installed_sampler(ctx: Context, child: int, secret: str) -> None:
    """Find `child` under this process in one unranked scan by the plugin's installed sampler.

    Inclusion is checked against the full scan, not the tool's top-50 ranking, so it does not depend on
    how many larger or busier processes the host runs. The scan need not be complete: a process exiting
    mid-scan marks it partial on any busy host, and requiring completeness would make the gate host-flaky.
    The target is the known child, which must be in it; a miss names the scan's coverage, so a truncated
    scan (`deadline`, `pid-limit`, `byte-limit`) is reported as such, never as a missing child. An
    independent `ps` confirms the parent. The child's name must be its kernel executable basename, no
    window of its argv[0]/title/comm secret may appear anywhere in the scan, and a real in-flight sample
    must reject with the abort reason.

    Parameters:
        ctx (Context): Scenario context.
        child (int): Marker child PID, started by this process.
        secret (str): The child's argv[0], title and Linux comm.

    Raises:
        ContractError: If the sampler resolves elsewhere, the scan fails or leaks, cancellation does not
            reject, or the child, its name or its parent is wrong.
    """
    done = run(
        [ctx.sandbox.tools.node, "--input-type=module", "-e", SAMPLER_DISCOVERY_PROBE, str(child), secret],
        env=ctx.sandbox.env(),
        cwd=ctx.installed,
        timeout=30,
    )
    try:
        report = SamplerDiscovery.model_validate_json(done.stdout)
    except ValidationError as e:
        raise ContractError(f"Sampler discovery probe output is malformed: {e}") from e
    expected = (
        ctx.installed.parents[2] / "node_modules" / RESOURCE_SAMPLER_CONTRACT.name / "dist" / "index.js"
    )
    require(
        Path(report.resolved) == expected.resolve(),
        f"plugin resolves the sampler to {report.resolved}, not {expected}",
    )
    coverage = report.coverage
    require(
        "process-collection-unavailable" not in coverage.reasons,
        f"sampler scan failed: {coverage.reasons}",
    )
    scope = (
        "the complete scan"
        if coverage.complete
        else f"a PARTIAL scan ({coverage.sampled}/{coverage.enumerated} sampled, reasons {coverage.reasons})"
    )
    require(
        [(found.pid, found.parentPid) for found in report.found] == [(child, os.getpid())],
        f"marker child {child} under parent {os.getpid()} not in {scope}: {report.found}",
    )
    names = kernel_executable_names(ctx.sandbox.tools.node)
    require(report.found[0].name in names, f"marker child named {report.found[0].name!r}, not one of {names}")
    require(not report.leaked, "installed sampler names expose the marker's argv[0], title or comm")
    require(report.cancelled == "rejected", f"in-flight sample cancellation: {report.cancelled}")
    ps = run(
        [Path("/bin/ps"), "-o", "ppid=", "-p", str(child)],
        env={"LC_ALL": "C", "PATH": "/usr/bin:/bin"},
        cwd=ctx.work,
        timeout=30,
    )
    require(ps.stdout.strip() == str(os.getpid()), f"independent ps reports parent {ps.stdout.strip()!r}")


def exercise_resource_snapshot(ctx: Context) -> tuple[str, str]:
    """Run `resource_snapshot` through the packed plugin around a real marker child, then a refused call.

    The child is idle and small, with a random secret as argv[0], title and Linux comm
    (`start_hostile_child`); its discovery is proven against the installed sampler's full scan
    (`discover_child_with_installed_sampler`), and the tool output must be the bounded projection of
    such a scan: exactly `min(50, sampled)` entries with only the documented fields, and no window of the
    secret anywhere in the tool record.

    Parameters:
        ctx (Context): Scenario context.

    Returns:
        tuple[str, str]: The reported ranking and the out-of-bounds call's error text.

    Raises:
        ContractError: If the snapshot fails, the child is not discovered, or the refusal succeeds.
    """
    project = ctx.work / "resource"
    project.mkdir()
    argv = ["--model", f"{PROVIDER}/{PHYSICAL_MODEL}", "--mode", "json", "go"]
    secret = secrets.token_hex(16)
    with start_hostile_child(ctx, project, secret) as child:
        discover_child_with_installed_sampler(ctx, child.pid, secret)
        script = [ToolStep("resource_snapshot", {"process_limit": 50, "interval_ms": 300}), TextStep("done")]
        with ctx.provider_session(script):
            ok = run_pi(ctx.pi_bin, ctx.sandbox, ctx.installed, project, argv)
    require_clean_run(ok, "dev-tools resource_snapshot")
    record = ok.single_tool_result("resource_snapshot")
    require(not tool_is_error(record), f"resource_snapshot failed: {tool_text(record)}")
    dumped = json.dumps(record)
    require(
        not any(window in dumped for window in secret_windows(secret)),
        "resource_snapshot output exposes the marker's argv[0], title or comm",
    )
    structured = parse_tool_record(record).result.structuredContent or {}
    processes = structured.get("processes")
    require(
        isinstance(processes, dict) and processes.get("status") == "available",
        f"resource_snapshot has no process metadata: {structured}",
    )
    assert isinstance(processes, dict)  # Narrowed by `require` above.
    entries, coverage = processes.get("entries"), processes.get("coverage")
    require(
        isinstance(entries, list) and isinstance(coverage, dict) and isinstance(coverage.get("sampled"), int),
        f"resource_snapshot entries or coverage malformed: {processes}",
    )
    assert isinstance(entries, list)
    assert isinstance(coverage, dict)
    require(
        0 < len(entries) == min(50, coverage["sampled"]),
        f"{len(entries)} entries is not the 50-bounded projection of {coverage['sampled']} sampled",
    )
    require(
        all(
            isinstance(entry, dict)
            and set(entry) == {"pid", "parentPid", "cpu", "rssBytes", "executable"}
            and isinstance(entry["parentPid"], int)
            for entry in entries
        ),
        f"resource_snapshot entries carry unexpected fields: {entries[:3]}",
    )
    ranking = processes.get("ranking")
    expected = "interval-cpu" if sys.platform.startswith("linux") else "rss"
    require(
        ranking == expected, f"resource_snapshot ranking {ranking!r} is not {expected!r} on {sys.platform}"
    )

    refused_script = [ToolStep("resource_snapshot", {"process_limit": 51}), TextStep("done")]
    with ctx.provider_session(refused_script):
        bad = run_pi(ctx.pi_bin, ctx.sandbox, ctx.installed, project, argv)
    require_clean_run(bad, "dev-tools resource_snapshot out of bounds")
    refused = bad.single_tool_result("resource_snapshot")
    require(tool_is_error(refused), f"process_limit 51 must be an error result: {refused.get('result')}")
    return expected, tool_text(refused)


def scenario_subagents(ctx: Context) -> SubagentsEvidence:
    """The packed extension and its registry dependencies load in stock Pi, offer every tool, and run `Agent`.

    One faux parent turn calls `Agent` in the foreground; a routed faux child answers. That executes the
    spawn path, which is what imports `croner` and `nanoid` at runtime, so a dependency that fails to
    resolve from the installed tarball fails here with the tool list and stderr tail.

    Parameters:
        ctx (Context): Scenario context.

    Returns:
        SubagentsEvidence: Evidence recorded in the report.

    Raises:
        ContractError: If the extension fails to load, a tool is not offered, or `Agent` does not answer.
    """
    project = ctx.work / "project"
    project.mkdir()
    call = ToolStep(
        "Agent",
        {
            "description": "trivial task",
            "prompt": f"{SUBAGENTS_CHILD_MARKER}: reply with one word.",
            "subagent_type": "general-purpose",
            "run_in_background": False,
        },
    )
    routes = [Route(SUBAGENTS_CHILD_MARKER, [TextStep(SUBAGENTS_CHILD_TEXT)])]
    with ctx.provider_session([call, TextStep("done")], routes) as provider:
        result = run_pi(
            ctx.pi_bin,
            ctx.sandbox,
            ctx.installed,
            project,
            ["--model", f"{PROVIDER}/{PHYSICAL_MODEL}", "--mode", "json", "go"],
        )
    seen = [sorted(request.tools) for request in provider.requests if request.route is None][:1]
    require_clean_run(result, f"subagents load (parent tools seen: {seen})")
    require_tools(result, ctx.artifact.contract, ctx.siblings, provider.requests, all_tools=True)
    record = result.single_tool_result("Agent")
    require(
        not tool_is_error(record),
        f"subagents `Agent` failed: {record.get('result')}\ntools seen: {seen}\n{result.stderr[-1000:]}",
    )
    text = tool_text(record)
    require(
        SUBAGENTS_CHILD_TEXT in text,
        f"subagents `Agent` result lacks the child's answer: '{text[-300:]}'\n{result.stderr[-1000:]}",
    )
    return {"tools": sorted(ctx.artifact.contract.exposes_tools), "child_text": SUBAGENTS_CHILD_TEXT}


COMPUTER_USE_DESKTOP_TOOLS = frozenset({"desktop_screenshot", "desktop_input"})
MACHO_ARCH = Literal["arm64", "x64"]
MACHO_CPU_TYPES: Mapping[MACHO_ARCH, int] = {"arm64": 0x0100000C, "x64": 0x01000007}
MACHO_MAGIC_64 = b"\xcf\xfa\xed\xfe"


def host_platform() -> str:
    """Return the platform whose tool set stock Pi will see (a seam for tests).

    Returns:
        str: `sys.platform`.
    """
    return sys.platform


def computer_use_expected_tools(platform: str) -> frozenset[str]:
    """Return the exact tools `extensions/computer-use.ts` registers on `platform`.

    `desktop_screenshot` and `desktop_input` are registered on darwin only, so non-darwin hosts
    (CI's ubuntu-24.04 cell) must see the other 11 and neither desktop tool.

    Parameters:
        platform (str): `sys.platform` value.

    Returns:
        frozenset[str]: Expected tool names.
    """
    tools = COMPUTER_USE_CONTRACT.exposes_tools
    return tools if platform == "darwin" else tools - COMPUTER_USE_DESKTOP_TOOLS


def check_macos_helper(tarball: Path, arch: MACHO_ARCH) -> str:
    """Require a packed `prebuilt/macos/<arch>/bridge` to be a thin 64-bit Mach-O of `arch`, mode 0755.

    The header is parsed here (little-endian magic then `cputype`), so it works on any host.

    Parameters:
        tarball (Path): Packed tarball.
        arch (MACHO_ARCH): `arm64` or `x64`.

    Returns:
        str: Human-readable summary recorded as evidence.

    Raises:
        ContractError: If the member is absent, not a Mach-O of that arch, or not mode 0755.
    """
    name = f"prebuilt/macos/{arch}/bridge"
    with tarfile.open(tarball) as tar:
        try:
            member = tar.getmember(f"package/{name}")
        except KeyError as e:
            raise ContractError(f"'{tarball.name}' has no '{name}'") from e
        handle = tar.extractfile(member)
        if handle is None:
            raise ContractError(f"'{tarball.name}:{name}' is not a regular file")
        mode = member.mode & 0o7777
        header = handle.read(8)
    require(
        header[:4] == MACHO_MAGIC_64,
        f"{name} is not a 64-bit little-endian Mach-O (magic {header[:4].hex()})",
    )
    cpu = int.from_bytes(header[4:8], "little")
    require(
        cpu == MACHO_CPU_TYPES[arch],
        f"{name} has cputype {cpu:#x}, expected {MACHO_CPU_TYPES[arch]:#x} for {arch}",
    )
    require(mode == 0o755, f"{name} has mode {mode:04o}, expected 0755")
    return f"Mach-O {arch} cputype {cpu:#x} mode {mode:04o}"


HELPER_SOURCE_LIST_DECLARATIONS = {
    "scripts/setup-helper.mjs": "helperSourcePaths",
    "scripts/build-native.mjs": "macosSourcePaths",
}
HELPER_SOURCE_LITERAL = re.compile(
    r"\s*(?P<quote>['\"])(?P<value>(?:\\.|(?!\1).)*)(?P=quote)\s*(?:,|$)", re.DOTALL
)


def parse_helper_source_list(script: str, source: str) -> list[str]:
    """Parse one packed script's complete literal Swift-source declaration.

    Parameters:
        script (str): Known packed build-script name selecting the declaration to inspect.
        source (str): Complete packed script text.

    Returns:
        list[str]: Declared literal Swift-source names, in declaration order.

    Raises:
        ContractError: If the expected declaration is absent or contains a non-literal token.
    """
    expected = HELPER_SOURCE_LIST_DECLARATIONS[script]
    declaration = re.compile(rf"\b{re.escape(expected)}\s*=\s*\[(?P<items>.*?)\]\s*\.map\b", re.DOTALL)
    match = declaration.search(source)
    require(match is not None, f"{script} has no '{expected}' helper source list")
    assert match is not None
    items = match.group("items")
    names: list[str] = []
    offset = 0
    while offset < len(items):
        if not items[offset:].strip():
            break
        literal = HELPER_SOURCE_LITERAL.match(items, offset)
        require(
            literal is not None,
            f"{script} helper source list has unsupported token (only plain string literals, no comments "
            f"or templates): {items[offset:].strip()!r}",
        )
        assert literal is not None
        names.append(literal.group("value"))
        offset = literal.end()
    require(bool(names), f"{script} helper source list names no .swift files")
    require(
        all(name.endswith(".swift") for name in names),
        f"{script} helper source list has unsupported non-Swift source",
    )
    return names


def check_helper_sources_packed(tarball: Path) -> list[str]:
    """Require every Swift source the packed build scripts compile to be in the tarball.

    `setup-helper.mjs` (`helperSourcePaths`) and `build-native.mjs` (`macosSourcePaths`) name the
    `native/macos/*.swift` files `--allow-build` and `build:native` compile. A name missing from the
    tarball would make both fail from an install, so the lists are read from the packed scripts.

    Parameters:
        tarball (Path): Packed tarball.

    Returns:
        list[str]: Sorted `native/macos/<file>` paths verified present.

    Raises:
        ContractError: If a script lacks the list or a listed source is not packed.
    """
    sources: set[str] = set()
    for script in HELPER_SOURCE_LIST_DECLARATIONS:
        names = parse_helper_source_list(script, read_member(tarball, script).decode())
        sources.update(f"native/macos/{name}" for name in names)
    for source in sorted(sources):
        read_member(tarball, source)
    return sorted(sources)


def scenario_computer_use(ctx: Context) -> ComputerUseEvidence:
    """Load packed computer-use, prove its platform's exact tool set and audit the shipped helpers.

    The tool set is platform-aware: 13 on darwin, 11 elsewhere (no desktop tools). Each packed
    macOS helper is checked as a Mach-O of the right arch with mode 0755. Not exercised, and recorded
    as `NOT RUN`: the `postinstall` (`setup-helper.mjs`; the stock install uses `--ignore-scripts`),
    because it creates a keychain signing identity, `pkill`s any running helper and registers the app
    with LaunchServices, which an isolated contract must not do to the host; and any desktop tool,
    which needs an interactive macOS desktop with Accessibility/Screen Recording TCC grants.

    Parameters:
        ctx (Context): Scenario context.

    Returns:
        ComputerUseEvidence: Evidence recorded in the report.

    Raises:
        ContractError: If a helper is malformed, the extension fails to load or the tool set is wrong.
    """
    platform = host_platform()
    expected = computer_use_expected_tools(platform)
    helpers: dict[str, str] = {arch: check_macos_helper(ctx.artifact.path, arch) for arch in MACHO_CPU_TYPES}
    helper_sources = check_helper_sources_packed(ctx.artifact.path)
    project = ctx.work / "project"
    project.mkdir()
    with ctx.provider_session([TextStep("loaded")]) as provider:
        result = run_pi(
            ctx.pi_bin,
            ctx.sandbox,
            ctx.installed,
            project,
            ["--model", f"{PROVIDER}/{PHYSICAL_MODEL}", "--mode", "json", "go"],
        )
    require_clean_run(result, f"computer-use extension load ({platform})")
    require_tools(
        result,
        replace(ctx.artifact.contract, exposes_tools=expected),
        ctx.siblings,
        provider.requests,
        all_tools=True,
    )
    offered = set(provider.requests[0].tools)
    leaked = (COMPUTER_USE_CONTRACT.exposes_tools - expected) & offered
    require(not leaked, f"computer-use on {platform} must not offer {sorted(leaked)}; got {sorted(offered)}")
    return {
        "platform": platform,
        "tools": sorted(expected),
        "helpers": helpers,
        "helper_sources": helper_sources,
        "postinstall": "NOT RUN",
        "postinstall_reason": (
            "stock install uses --ignore-scripts; setup-helper.mjs would create a keychain signing "
            "identity, pkill a running helper and register the app with LaunchServices"
        ),
        "native_desktop": "NOT RUN",
        "native_desktop_reason": (
            "requires an interactive macOS desktop and Accessibility/Screen Recording TCC grants"
        ),
    }


def scenario_session_kit(ctx: Context) -> SessionKitEvidence:
    """Real monitor tools, then the standalone stats artifact over the resulting real session.

    Parameters:
        ctx (Context): Scenario context.

    Returns:
        SessionKitEvidence: Evidence recorded in the report.

    Raises:
        ContractError: If the monitor or the artifact misbehaves.
    """
    marker = "kit-contract-line"
    script = [
        ToolStep(
            "monitor_start",
            {"name": "contract", "argv": [str(ctx.sandbox.tools.node), "-e", f"console.log('{marker}')"]},
        ),
        ToolStep("monitor_read", {"id": "contract"}),
        TextStep("done"),
    ]
    project = ctx.work / "project"
    project.mkdir()
    sessions = ctx.sandbox.agent_dir / "sessions"
    with ctx.provider_session(script) as provider:
        result = run_pi(
            ctx.pi_bin,
            ctx.sandbox,
            ctx.installed,
            project,
            ["--model", f"{PROVIDER}/{PHYSICAL_MODEL}", "--mode", "json", "go"],
            session_dir=sessions,
        )
    require_clean_run(result, "session-kit monitor")
    require_tools(result, ctx.artifact.contract, ctx.siblings, provider.requests)
    started = result.single_tool_result("monitor_start")
    require(
        not tool_is_error(started) and "started m1" in tool_text(started),
        f"monitor_start: {tool_text(started)}",
    )
    read = result.single_tool_result("monitor_read")
    require(marker in tool_text(read), f"monitor_read missed '{marker}': {tool_text(read)}")

    # The exact packed bytes must run with only `node`, alone in an unrelated directory (no sibling
    # `src/`, package or `node_modules`), over that real session.
    manifest = exercise_stats_artifact(
        ctx.sandbox.tools.node,
        read_member(ctx.artifact.path, STATS_ARTIFACT),
        ctx.sandbox.agent_dir,
        ctx.work,
    )
    return {
        "tools": ["monitor_start", "monitor_read"],
        "monitor_line": marker,
        "stats_shards": len(manifest.shards),
    }


def require_clean_stats_home(home: Path, agent: Path) -> None:
    """Reject credentials, package installations and settings created by standalone operations.

    Parameters:
        home (Path): Clean process home.
        agent (Path): Explicit producer/viewer agent directory.

    Raises:
        ContractError: A forbidden file or package directory appeared.
    """
    for name in ("auth.json", "settings.json", "git", "npm"):
        require(not (agent / name).exists(), f"standalone stats created '{name}'")
    require(not list(home.rglob("node_modules")), "standalone stats created node_modules")


def inspect_stats_snapshot(directory: Path, machine_id: str, forbidden: Sequence[str]) -> StatsManifest:
    """Inspect exact manifest/month bytes, strict usage-only fields and privacy sentinels.

    Parameters:
        directory (Path): Exported machine directory.
        machine_id (str): UUID from the export response.
        forbidden (Sequence[str]): Private strings forbidden anywhere in snapshot bytes.

    Returns:
        StatsManifest: Validated manifest with at least one real event.

    Raises:
        ContractError: A file is missing, corrupt, private or inconsistent with its manifest.
    """
    try:
        manifest_text = (directory / "manifest.json").read_text()
        manifest = parse_stats_json(StatsManifest, manifest_text, "manifest")
        require(manifest.machineId == machine_id, "export manifest changed its installation UUID")
        require(bool(manifest.shards), "export: the manifest references no shards")
        texts = [path.read_text() for path in directory.rglob("*") if path.is_file()]
        events = 0
        for ref in manifest.shards:
            data = (directory / ref.file).read_bytes()
            require(
                len(data) == ref.bytes and hashlib.sha256(data).hexdigest() == ref.sha256,
                "export month shard disagrees with its content identity",
            )
            text = data.decode()
            shard = parse_stats_json(StatsShard, text, "month shard")
            require((shard.machineId, shard.month) == (machine_id, ref.month), "export shard header mismatch")
            events += len(shard.events)
        require(events > 0, "export produced no usage events")
        exported = "\n".join(texts)
        for secret in forbidden:
            require(secret not in exported, f"export leaked a private sentinel: '{secret}'")
        return manifest
    except (OSError, UnicodeError) as e:
        raise ContractError(f"Cannot inspect stats snapshot '{directory}': {e}") from e


def inspect_stats_cache(viewer: Path, manifest: StatsManifest, snapshot_dir: Path) -> object:
    """Require an import to persist exactly the manifest and month events it consumed.

    Parameters:
        viewer (Path): Clean viewer agent directory.
        manifest (StatsManifest): Validated producer manifest.
        snapshot_dir (Path): Export directory holding the expected month bytes.

    Returns:
        object: Stable machine map for comparison after repeated imports.

    Raises:
        ContractError: Persistent data is absent, malformed or changed.
    """
    try:
        cache = json.loads((viewer / "pi-session-kit" / "stats-global.json").read_text())
    except (OSError, ValueError) as e:
        raise ContractError(f"import left no readable persistent cache: {e}") from e
    require(isinstance(cache, dict), "import cache is not an object")
    machines = cache.get("machines")
    require(
        isinstance(machines, dict) and set(machines) == {manifest.machineId}, "import cache lost the producer"
    )
    machine = machines[manifest.machineId]
    require(isinstance(machine, dict), "import cache machine is not an object")
    require(machine.get("manifest") == manifest.model_dump(), "import cache changed the manifest")
    expected = [json.loads((snapshot_dir / ref.file).read_text()) for ref in manifest.shards]
    require(machine.get("shards") == expected, "import cache changed or duplicated month events")
    return machines


def exercise_stats_artifact(node: Path, artifact: bytes, agent_dir: Path, work: Path) -> StatsManifest:
    """Run packed bytes in clean producer/viewer homes, twice, with private source sentinels.

    Only the source sessions are copied, never settings, auth, packages or an ambient environment.
    The standalone file has no neighboring source tree or modules. Real execution belongs to CI's
    `contracts` job; unit tests substitute the process boundary and attack the inspections.

    Parameters:
        node (Path): Absolute `node` path.
        artifact (bytes): Exact bytes of the packed `dist/pi-stats-export.mjs`.
        agent_dir (Path): Agent directory holding the real session to export.
        work (Path): Scratch directory; created if absent and used only for this run.

    Returns:
        StatsManifest: The validated exported manifest.

    Raises:
        ContractError: If any command fails or any consumed document is malformed.
    """
    standalone = work / "standalone"
    standalone.mkdir(parents=True)
    script = standalone / "pi-stats-export.mjs"
    script.write_bytes(artifact)
    outside = work / "artifact-cwd"
    outside.mkdir()
    snapshots = work / "snapshots"
    producer_home = work / "producer-home"
    producer = producer_home / ".pi" / "agent"
    shutil.copytree(agent_dir / "sessions", producer / "sessions" / "--private-source-path--")
    histories = list(producer.rglob("*.jsonl"))
    require(bool(histories), "stats producer has no source history")
    for history in histories:
        entries = [json.loads(line) for line in history.read_text().splitlines() if line.strip()]
        for entry in entries:
            if entry.get("type") == "session":
                entry["cwd"] = str(history.parent)
            message = entry.get("message")
            if isinstance(message, dict):
                message["content"] = [{"type": "text", "text": STATS_PRIVATE_SENTINEL}]
        entries.append({"type": "session_info", "name": STATS_PRIVATE_SENTINEL})
        history.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n")
    producer_env = {"HOME": str(producer_home), "PATH": os.defpath, "TZ": "UTC"}
    exports: list[StatsExportResult] = []
    manifests: list[StatsManifest] = []
    for _ in range(2):
        exported = run(
            [node, script, "export", "--agent-dir", producer, "--output", snapshots],
            env=producer_env,
            cwd=outside,
            timeout=PI_TIMEOUT_S,
        )
        export = parse_stats_json(StatsExportResult, exported.stdout, "export")
        expected_dir = snapshots / "machines" / export.machineId
        require(Path(export.snapshotDir) == expected_dir, "export wrote an unexpected snapshot directory")
        manifest = inspect_stats_snapshot(
            expected_dir,
            export.machineId,
            [
                STATS_PRIVATE_SENTINEL,
                str(producer_home),
                *(str(path) for path in histories),
                "--private-source-path--",
                '"content"',
                '"cwd"',
            ],
        )
        exports.append(export)
        manifests.append(manifest)
    require(exports[0] == exports[1], "repeat export changed the installation UUID or directory")
    require(manifests[0].shards == manifests[1].shards, "repeat export changed month-shard identities")
    require_clean_stats_home(producer_home, producer)
    viewer_home = work / "viewer-home"
    viewer = viewer_home / ".pi" / "agent"
    viewer.mkdir(parents=True)
    viewer_env = {"HOME": str(viewer_home), "PATH": os.defpath, "TZ": "UTC"}
    caches: list[object] = []
    for _ in range(2):
        imported = parse_stats_json(
            StatsImportResult,
            run(
                [node, script, "import", "--agent-dir", viewer, "--input", snapshots],
                env=viewer_env,
                cwd=outside,
                timeout=PI_TIMEOUT_S,
            ).stdout,
            "import",
        )
        require(
            (imported.imported, imported.retained, imported.problems) == (1, 0, []), f"import: {imported}"
        )
        caches.append(inspect_stats_cache(viewer, manifests[-1], Path(exports[-1].snapshotDir)))
    require(caches[0] == caches[1], "repeat import duplicated or changed cached usage")
    require_clean_stats_home(viewer_home, viewer)
    bad = run(
        [node, script, "export", "--bogus", "x"],
        env=producer_env,
        cwd=outside,
        timeout=PI_TIMEOUT_S,
        check=False,
    )
    require(bad.returncode != 0, "stats artifact accepted an unknown flag")
    return manifests[-1]


def scenario_router(ctx: Context) -> RouterEvidence:
    """Virtual `router/default` registration and dispatch to a physical model, plus a rejected config.

    Parameters:
        ctx (Context): Scenario context.

    Returns:
        RouterEvidence: Evidence recorded in the report.

    Raises:
        ContractError: If routing misbehaves.
    """
    config = ctx.sandbox.agent_dir / "subscription-router.json"
    config.write_text(
        json.dumps(
            {
                "profiles": {
                    "default": {"name": "Contract", "chain": [{"model": f"{PROVIDER}/{PHYSICAL_MODEL}"}]}
                }
            }
        )
    )
    project = ctx.work / "project"
    project.mkdir()
    base = ["--mode", "json", "go"]
    with ctx.provider_session([TextStep("routed")]) as provider:
        listing = run_pi(ctx.pi_bin, ctx.sandbox, ctx.installed, project, ["--list-models", "router"])
        routed = run_pi(ctx.pi_bin, ctx.sandbox, ctx.installed, project, ["--model", "router/default", *base])
    require(
        listing.returncode == 0 and "default" in listing.stdout,
        f"router/default not listed:\n{listing.stdout}{listing.stderr}",
    )
    require_clean_run(routed, "router dispatch")
    require_tools(routed, ctx.artifact.contract, ctx.siblings, provider.requests)
    require(
        [r.model for r in provider.requests] == [PHYSICAL_MODEL], f"physical requests: {provider.requests}"
    )
    answers = routed.assistant_messages()
    require(len(answers) == 1, f"expected one assistant message, got {len(answers)}")
    answer = MessageEnvelope.model_validate(answers[0])
    require(
        (answer.provider, answer.model) == (PROVIDER, PHYSICAL_MODEL),
        f"dispatched to {answer.provider}/{answer.model}",
    )

    config.write_text(json.dumps({"profiles": {"Bad Id": {"chain": []}}}))
    with ctx.provider_session([TextStep("unused")]):
        rejected = run_pi(ctx.pi_bin, ctx.sandbox, ctx.installed, project, ["--list-models", "router"])
    require(rejected.returncode == 0, f"a rejected router config must not crash Pi:\n{rejected.stderr}")
    require(
        "default" not in rejected.stdout and "Bad Id" not in rejected.stdout,
        f"rejected config registered models:\n{rejected.stdout}",
    )
    return {
        "virtual_model": "router/default",
        "dispatched": f"{PROVIDER}/{PHYSICAL_MODEL}",
        "balanced": exercise_packed_router(ctx, project, "balanced"),
        "fallback": exercise_packed_router(ctx, project, "fallback"),
        "recovery": exercise_packed_router(ctx, project, "recovery"),
    }


def exercise_packed_router(
    ctx: Context, project: Path, mode: Literal["balanced", "fallback", "recovery"]
) -> list[str]:
    """Exercise installed factory bytes with real stock-Pi streams and three loopback providers.

    Parameters:
        ctx (Context): Isolated installed artifact and stock host.
        project (Path): Disposable working directory.
        mode (Literal["balanced", "fallback", "recovery"]): Scenario to execute.

    Returns:
        list[str]: Physical assistant attempts, including the failed recovery attempt.

    Raises:
        ContractError: If provider dispatch, tool isolation or recovery differs from the contract.
    """
    source = (REPO_ROOT / "scripts" / "router_contract.mjs").read_text()
    wrapper = ctx.work / f"router-{mode}.mjs"
    wrapper.write_text(
        source.replace("PACKED_ROUTER_INDEX", json.dumps((ctx.installed / "src/index.ts").as_posix())[1:-1])
        .replace("PACKED_ROUTER_USAGE", json.dumps((ctx.installed / "src/usage.ts").as_posix())[1:-1])
        .replace("CONTRACT_MODE", mode)
    )
    first: Step = (
        ErrorStep("insufficient_quota: synthetic exhausted subscription")
        if mode == "recovery"
        else TextStep("a")
    )
    with FauxProvider([first]) as a, FauxProvider([TextStep("b")]) as b, FauxProvider([TextStep("c")]) as c:
        providers = {}
        for server, name, model in [(a, "anthropic", "m-a"), (b, "openai-codex", "m-b"), (c, "local", "m-c")]:
            providers |= json.loads(models_json(server.base_url, name, [model]))["providers"]
        (ctx.sandbox.agent_dir / "models.json").write_text(json.dumps({"providers": providers}))
        result = run_pi(
            ctx.pi_bin, ctx.sandbox, wrapper, project, ["--model", "router/default", "--mode", "json", "go"]
        )
    require_clean_run(result, f"packed router {mode}")
    expected = {
        "balanced": ["openai-codex/m-b"],
        "fallback": ["local/m-c"],
        "recovery": ["anthropic/m-a", "openai-codex/m-b"],
    }[mode]
    attempts = [MessageEnvelope.model_validate(message) for message in result.assistant_messages()]
    physical = [f"{message.provider}/{message.model}" for message in attempts]
    require(physical == expected, f"packed router {mode}: expected {expected}, got {physical}")
    require(
        [len(a.requests), len(b.requests), len(c.requests)]
        == {
            "balanced": [0, 1, 0],
            "fallback": [0, 0, 1],
            "recovery": [1, 1, 0],
        }[mode],
        f"packed router {mode}: unexpected provider request count",
    )
    require_tools(result, ctx.artifact.contract, ctx.siblings, [*a.requests, *b.requests, *c.requests])
    require(
        result.assistant_messages()[-1].get("stopReason") == "stop",
        "packed router did not settle successfully",
    )
    return physical


def todo_snapshot_subject(record: dict[str, Any]) -> str | None:
    """Read the first task subject from a todo result's persisted `details` snapshot.

    Parameters:
        record (dict[str, Any]): A `todo` `tool_execution_end` event.

    Returns:
        str | None: `result.details.tasks[0].subject`, or `None` when the snapshot is absent or mistyped.
    """
    result = record.get("result")
    details = result.get("details") if isinstance(result, dict) else None
    tasks = details.get("tasks") if isinstance(details, dict) else None
    first = tasks[0] if isinstance(tasks, list) and tasks else None
    subject = first.get("subject") if isinstance(first, dict) else None
    return subject if isinstance(subject, str) else None


def scenario_todo(ctx: Context) -> TodoEvidence:
    """Load the packed extension and create one todo through stock Pi.

    Parameters:
        ctx (Context): Scenario context.

    Returns:
        TodoEvidence: Registered tool and the subject read back from `details.tasks[0]`.

    Raises:
        ContractError: If the tool is absent or does not create and snapshot the requested task.
    """
    subject = "stock contract task"
    project = ctx.work / "project"
    project.mkdir(exist_ok=True)
    with ctx.provider_session(
        [ToolStep("todo", {"action": "create", "subject": subject}), TextStep("done")]
    ) as provider:
        result = run_pi(
            ctx.pi_bin,
            ctx.sandbox,
            ctx.installed,
            project,
            ["--model", f"{PROVIDER}/{PHYSICAL_MODEL}", "--mode", "json", "go"],
        )
    require_clean_run(result, "todo create")
    require_tools(result, ctx.artifact.contract, ctx.siblings, provider.requests, all_tools=True)
    record = result.single_tool_result("todo")
    require(not tool_is_error(record), f"todo create failed: {tool_text(record)}")
    require(subject in tool_text(record), f"todo result omitted '{subject}': {record.get('result')}")
    require(
        todo_snapshot_subject(record) == subject,
        f"todo result details.tasks[0] did not persist '{subject}': {record.get('result')}",
    )
    return {"tools": ["todo"], "subject": subject}


def scenario_plan_mode(ctx: Context) -> PlanModeEvidence:
    """Load the packed Plan extension, enter Plan mode and call its question tool.

    The one-shot prompt `/plan <prompt>` enters Plan mode and submits a turn (a bare `/plan start`
    sends none). The faux model calls `plan_mode_question`; headless JSON mode has no UI, so the tool
    must answer with `ui_unavailable`. Both Plan tools must be offered in the model request.

    Parameters:
        ctx (Context): Scenario context.

    Returns:
        PlanModeEvidence: Registered Plan tools and the question tool's result text.

    Raises:
        ContractError: If loading fails, a Plan tool is absent, or the question result lacks
            `ui_unavailable`.
    """
    project = ctx.work / "project"
    project.mkdir(exist_ok=True)
    question = ToolStep(
        "plan_mode_question",
        {
            "questions": [
                {
                    "id": "contract_scope",
                    "header": "Scope",
                    "question": "Exercise the packed Plan-mode question tool?",
                    "options": [
                        {"label": "Yes", "description": "Record the active headless result."},
                        {"label": "No", "description": "The contract still records active Plan mode."},
                    ],
                }
            ]
        },
    )
    with ctx.provider_session([question, TextStep("loaded")]) as provider:
        result = run_pi(
            ctx.pi_bin,
            ctx.sandbox,
            ctx.installed,
            project,
            # `/plan start` sends no turn; `/plan <prompt>` enters Plan mode, then submits.
            ["--model", f"{PROVIDER}/{PHYSICAL_MODEL}", "--mode", "json", "/plan exercise the question tool"],
        )
    require_clean_run(result, "plan-mode active tool")
    require_tools(result, ctx.artifact.contract, ctx.siblings, provider.requests, all_tools=True)
    question_result = tool_text(result.single_tool_result("plan_mode_question"))
    require("ui_unavailable" in question_result, f"unexpected active Plan question result: {question_result}")
    return {"tools": sorted(ctx.artifact.contract.exposes_tools), "question_result": question_result}


SCENARIOS: dict[str, Callable[[Context], ScenarioEvidence]] = {
    "dev-tools": scenario_dev_tools,
    "session-kit": scenario_session_kit,
    "subscription-router": scenario_router,
}


# --- orchestration --------------------------------------------------------------------------------


def run_gate(
    work: Path,
    stock_prefix: Path,
    only: Sequence[str] | None,
    supplied: Mapping[str, Path] | None = None,
    *,
    contracts: Sequence[PackageContract] = CONTRACTS,
    scenarios: Mapping[str, Callable[[Context], ScenarioEvidence]] = SCENARIOS,
    siblings: Sequence[PackageContract] = CONTRACTS,
) -> ContractReport:
    """Run the whole contract gate and build the identity/evidence report.

    Parameters:
        work (Path): Empty scratch directory for tarballs, installs and sandboxes.
        stock_prefix (Path): Reusable stock Pi install directory.
        only (Sequence[str] | None): Package directories to restrict to; `None` runs all.
        supplied (Mapping[str, Path] | None): Existing tarballs by package directory; never repacked.
        contracts (Sequence[PackageContract]): Contracts eligible for this invocation.
        scenarios (Mapping[str, Callable[[Context], ScenarioEvidence]]): Executable gate per directory.
        siblings (Sequence[PackageContract]): Every peer contract to test for leaked sibling tools.

    Returns:
        ContractReport: Validated report.

    Raises:
        ContractError: On the first violated contract or a malformed report, after all static audits ran.
    """
    selected = [contract for contract in contracts if only is None or contract.directory in only]
    if not selected:
        raise ContractError("No release contract matches the requested subject")
    missing_gates = [contract.directory for contract in selected if contract.directory not in scenarios]
    if missing_gates:
        raise ContractError(f"No executable stock gate for: {', '.join(missing_gates)}")
    selected_directories = {contract.directory for contract in selected}
    extra_subjects = set(supplied or {}) - selected_directories
    if extra_subjects:
        raise ContractError(
            f"Supplied tarballs have no selected release contract: {', '.join(sorted(extra_subjects))}"
        )
    tools = locate_tools()
    root_license = (REPO_ROOT / "LICENSE").read_bytes()
    base = Sandbox(work / "base", tools)
    pi_bin = ensure_stock_pi(stock_prefix, base)
    tarballs = work / "tarballs"
    tarballs.mkdir()
    artifacts = [select_artifact(contract, tarballs, base, supplied or {}) for contract in selected]

    problems = [
        f"{a.contract.name}: {p}" for a in artifacts for p in audit_tarball(a, root_license, tools.node)
    ]
    if problems:
        raise ContractError("Tarball audit failed:\n" + "\n".join(f"  - {p}" for p in problems))

    packages: dict[str, object] = {}
    for artifact in artifacts:
        contract = artifact.contract
        sandbox = Sandbox(work / f"sandbox-{contract.directory}", tools)
        installed = install_alone(artifact, sandbox, sandbox.root / "project")
        scratch = sandbox.root / "scenario"
        scratch.mkdir()
        sibling_contracts = tuple(candidate for candidate in siblings if candidate is not contract)
        LOGGER.info(f"Exercising '{contract.name}' through stock Pi {STOCK_PI_VERSION}")
        evidence = scenarios[contract.directory](
            Context(pi_bin, sandbox, installed, artifact, scratch, sibling_contracts)
        )
        if not dict(evidence):
            raise ContractError(f"Stock gate produced empty subject evidence for '{contract.name}'")
        packages[contract.name] = {
            "version": artifact.version,
            "tarball": artifact.path.name,
            "integrity": artifact.integrity,
            "shasum": artifact.shasum,
            "size": artifact.size,
            "files": list(artifact.files),
            "evidence": evidence,
        }
    return validate_report(
        {
            "stock_pi": {
                "package": STOCK_PI_PACKAGE,
                "version": STOCK_PI_VERSION,
                "integrity": STOCK_PI_INTEGRITY,
            },
            "node": run([tools.node, "--version"], env=base.env(), cwd=work, timeout=30).stdout.strip(),
            "npm": run([tools.npm, "--version"], env=base.env(), cwd=work, timeout=30).stdout.strip(),
            "license_sha256": hashlib.sha256(root_license).hexdigest(),
            "packages": packages,
        }
    )


def run_audit_gate(
    work: Path, contract: PackageContract, supplied: Mapping[str, Path] | None = None
) -> dict[str, object]:
    """Audit and install one packed package that has no standalone Pi behavior.

    The preset ships agents and themes only, so there is nothing to execute through stock Pi alone.
    Its packed bytes still get the full tarball audit (files, manifest, license expression) and the
    clean-install closure check. Agent behavior in real children lives in the in-process suite.

    Parameters:
        work (Path): Empty scratch directory.
        contract (PackageContract): Package to pack or load, audit and install.
        supplied (Mapping[str, Path] | None): Existing tarballs by directory, never repacked.

    Returns:
        dict[str, object]: Artifact identity and file list.

    Raises:
        ContractError: If the tarball audit or the clean install fails.
    """
    tools = locate_tools()
    sandbox = Sandbox(work / "base", tools)
    tarballs = work / "tarballs"
    tarballs.mkdir()
    artifact = select_artifact(contract, tarballs, sandbox, supplied or {})
    problems = audit_tarball(artifact, (REPO_ROOT / "LICENSE").read_bytes(), tools.node)
    if problems:
        raise ContractError(
            f"Tarball audit failed for '{contract.name}':\n" + "\n".join(f"  - {p}" for p in problems)
        )
    install_alone(artifact, sandbox, work / "install")
    if contract.node_probe:
        run(
            [tools.node, "--input-type=module", "-e", contract.node_probe],
            env=sandbox.env(),
            cwd=work / "install",
            timeout=30,
            own_group=True,
        )
    return {
        "name": contract.name,
        "version": artifact.version,
        "tarball": artifact.path.name,
        "integrity": artifact.integrity,
        "shasum": artifact.shasum,
        "size": artifact.size,
        "files": list(artifact.files),
    }


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    """Parse the command line.

    Parameters:
        argv (Sequence[str] | None): Arguments, or `None` for `sys.argv`.

    Returns:
        argparse.Namespace: Parsed options.
    """
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument(
        "--stock-prefix", type=Path, default=DEFAULT_STOCK_PREFIX, help="Reusable stock Pi install directory"
    )
    parser.add_argument(
        "--work-dir", type=Path, help="Scratch directory (must be empty or absent); default: a temporary one"
    )
    parser.add_argument("--keep", action="store_true", help="Keep the scratch directory after the run")
    parser.add_argument("--tarball", action="append", default=[], metavar="DIRECTORY=PATH")
    parser.add_argument("--report", type=Path, help="Write the JSON identity/evidence report here")
    parser.add_argument(
        "--package", action="append", choices=[c.directory for c in CONTRACTS], help="Restrict to one package"
    )
    parser.add_argument(
        "--audit-preset", action="store_true", help="Only audit and install the packed `@nredd/pi-preset`"
    )
    parser.add_argument(
        "--audit-resource-sampler",
        action="store_true",
        help="Audit and exercise the packed resource sampler library",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point.

    Parameters:
        argv (Sequence[str] | None): Arguments, or `None` for `sys.argv`.

    Returns:
        int: 0 when every contract holds, 1 on a violation, 2 on a usage error.
    """
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args = parse_args(argv)
    if args.work_dir is not None and args.work_dir.exists() and any(args.work_dir.iterdir()):
        LOGGER.error(f"`--work-dir` must be empty: '{args.work_dir}'")
        return 2
    work = args.work_dir or Path(tempfile.mkdtemp(prefix="pi-package-contracts-"))
    work.mkdir(parents=True, exist_ok=True)
    try:
        if args.audit_preset or args.audit_resource_sampler:
            contract = RESOURCE_SAMPLER_CONTRACT if args.audit_resource_sampler else PRESET_CONTRACT
            evidence = run_audit_gate(work.resolve(), contract)
            text = json.dumps(evidence, indent=2, sort_keys=True) + "\n"
            if args.report:
                args.report.write_text(text)
            sys.stdout.write(text)
            LOGGER.info(f"'{contract.name}' package audit: passed")
            return 0
        supplied = parse_tarballs(args.tarball, CONTRACTS)
        only = args.package or (list(supplied) if supplied else None)
        if supplied and only is not None and set(supplied) - set(only):
            raise ContractError("Every `--tarball` must be selected by `--package`")
        report = run_gate(work.resolve(), args.stock_prefix.resolve(), only, supplied)
    except ContractError as e:
        LOGGER.error(f"FAILED: {e}")
        return 1
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)
    text = serialize_report(report)
    if args.report:
        args.report.write_text(text)
    sys.stdout.write(text)
    LOGGER.info("package contracts: all passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
