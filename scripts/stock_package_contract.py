"""Run one packed package contract against stock Pi outside a release.

References:
    https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
    https://docs.npmjs.com/cli/v11/commands/npm-pack
    https://docs.npmjs.com/cli/v11/commands/npm-install
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


def main(argv: Sequence[str] | None = None) -> int:
    """Pack, audit, install, and exercise one declared package through stock Pi.

    Parameters:
        argv (Sequence[str] | None): Arguments, or `None` for `sys.argv`.

    Returns:
        int: Zero after a successful contract; one after a contract violation.
    """
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    parser.add_argument("--package", required=True, dest="package", help="Declared npm package name")
    parser.add_argument("--stock-prefix", type=Path, default=pc.DEFAULT_STOCK_PREFIX)
    parser.add_argument("--report", type=Path, help="Write the JSON identity/evidence report here")
    args = parser.parse_args(argv)
    descriptor = rd.descriptor_for(args.package)
    if descriptor is None:
        LOGGER.error(f"FAILED: no release descriptor for '{args.package}'")
        return 1
    work = Path(tempfile.mkdtemp(prefix=f"{descriptor.workspace.name}-contract-"))
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
    LOGGER.info(f"{descriptor.workspace.name} package contract: passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
