"""Run the packed `@nredd/pi-subagents` stock contract outside a release.

`make check-package-contracts` installs offline, so it cannot cover this package's registry
dependencies. This entry point runs the exact gate the release `verify` stage runs
(`npm_release.run_stock_contract`: same contract, scenario and sibling set) on a freshly packed
tarball, so CI executes it before a tag does. Needs the npm registry.
"""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path

import npm_release as nr
import package_contracts as pc
import release_descriptors as rd

LOGGER = logging.getLogger(__name__)
SUBJECT = "@nredd/pi-subagents"


def main(argv: Sequence[str] | None = None) -> int:
    """Pack, audit, install from the registry and exercise `@nredd/pi-subagents`.

    Parameters:
        argv (Sequence[str] | None): Arguments, or `None` for `sys.argv`.

    Returns:
        int: 0 when the contract holds, 1 on a violation.
    """
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument("--stock-prefix", type=Path, default=pc.DEFAULT_STOCK_PREFIX)
    parser.add_argument("--report", type=Path, help="Write the JSON identity/evidence report here")
    args = parser.parse_args(argv)
    descriptor = rd.descriptor_for(SUBJECT)
    if descriptor is None:
        LOGGER.error(f"FAILED: no release descriptor for '{SUBJECT}'")
        return 1
    work = Path(tempfile.mkdtemp(prefix="pi-subagents-contract-"))
    try:
        report = nr.run_stock_contract(work, args.stock_prefix.resolve(), descriptor, {})
    except (pc.ContractError, nr.ReleaseError) as e:
        LOGGER.error(f"FAILED: {e}")
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)
    text = pc.serialize_report(report)
    if args.report:
        args.report.write_text(text)
    sys.stdout.write(text)
    LOGGER.info("subagents package contract: passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
