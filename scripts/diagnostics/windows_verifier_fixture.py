"""Diagnose the real Windows verifier with authenticated policy unchanged.

This fixture downloads public release bytes and attestations, never installs or executes them.
Only diagnostic verbosity and the actual Windows SYSTEMROOT runtime variable vary between trials.

References:
    https://github.com/nredd/pi-harness/issues/696
    https://github.com/cli/cli/blob/trunk/pkg/cmd/attestation/verification/sigstore.go
    https://github.com/cli/go-gh/blob/trunk/pkg/config/config.go
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any
from unittest.mock import patch

from harness import release

LOGGER = logging.getLogger(__name__)
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
RUNTIME_KEYS = ("HOME", "USERPROFILE", "LOCALAPPDATA", "SYSTEMROOT", "TMP", "TEMP", "XDG_CACHE_HOME")


def verify_trial(
    asset: Path, tag: str, bundle: Path, output: Path, label: str, *, restore_system_root: bool = False
) -> bool:
    """Run the actual shared verifier with bounded, credential-free diagnostic instrumentation.

    Parameters:
        asset (Path): Checksum-verified public artifact, never executed.
        tag (str): Exact source tag to enforce.
        bundle (Path): Public attestation bundle.
        output (Path): Receipt directory.
        label (str): Trial identity.
        restore_system_root (bool): Restore only the native OS runtime location after filtering.

    Returns:
        bool: Whether the real verifier accepted the unchanged identity policy.
    """
    original = subprocess.check_output
    ledger: list[dict[str, object]] = []

    def instrument(command: list[str], **kwargs: Any) -> str:
        """Enable non-HTTP debug messages while still invoking the real native executable.

        Parameters:
            command (list[str]): Original verifier argv, unchanged.
            kwargs (Any): Original subprocess arguments.

        Returns:
            str: Actual native output.
        """
        env = kwargs["env"] | {"GH_DEBUG": "1", "GH_FORCE_TTY": "80"}
        if restore_system_root:
            system_root = Path(os.environ["SYSTEMROOT"])
            assert system_root.is_absolute()
            assert system_root.is_dir()
            env["SYSTEMROOT"] = str(system_root)
        assert not any(key in env for key in release.GITHUB_TOKEN_VARIABLES)
        ledger.append({"argv": command, "runtimeKeysPresent": {key: key in env for key in RUNTIME_KEYS}})
        kwargs["env"] = env
        try:
            result = original(command, **kwargs)
        except subprocess.CalledProcessError as error:
            result = error.output
            assert isinstance(result, str)
            (output / f"{label}.log").write_text(ANSI.sub("", release.redact_diagnostic(result)))
            raise
        assert isinstance(result, str)
        (output / f"{label}.log").write_text(ANSI.sub("", release.redact_diagnostic(result)))
        return result

    try:
        with patch.object(release.subprocess, "check_output", side_effect=instrument):
            release.verify_attestation(
                asset, release.CORE_REPO, release.ATTESTATION_WORKFLOW, f"refs/tags/{tag}", bundle
            )
    except RuntimeError as error:
        LOGGER.error(f"{label}: {release.redact_diagnostic(str(error))}")
        return False
    finally:
        (output / f"{label}-command.json").write_text(json.dumps(ledger, indent=2))
    LOGGER.info(f"{label}: actual native verification succeeded")
    return True


def main() -> None:
    """Require native DNS refusal under filtering and successful verification with SYSTEMROOT alone."""
    if sys.platform != "win32":
        raise RuntimeError("This diagnostic requires native Windows; no cross-platform acceptance")
    output = Path(os.environ["RUNNER_TEMP"]) / "windows-verifier-fixture"
    output.mkdir()
    manifest = json.loads(Path("package.json").read_text())
    tag, url = release._root_override_pins(manifest)["@earendil-works/pi-ai"]
    checksums = release.release_checksums(tag)
    asset = output / "public-asset.tgz"
    asset.write_bytes(release.fetch_bytes(url))
    actual = hashlib.sha256(asset.read_bytes()).hexdigest()
    if actual != checksums[url]:
        raise ValueError("Fixture download does not match the published release checksum")
    (output / "asset-sha256.txt").write_text(f"{actual}\n")
    bundle = release.attestation_bundle(release.CORE_REPO, asset, output / "bundle.jsonl")
    baseline = verify_trial(asset, tag, bundle, output, "baseline-filtered")
    restored = verify_trial(asset, tag, bundle, output, "systemroot-only", restore_system_root=True)
    (output / "outcomes.json").write_text(
        json.dumps({"baseline": baseline, "systemRootOnly": restored}, indent=2)
    )
    if baseline:
        raise RuntimeError("Baseline did not reproduce the native refusal; no repository fix established")
    if not restored:
        raise RuntimeError("SYSTEMROOT-only hypothesis refuted; inspect exact verbose native receipts")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
