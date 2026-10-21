"""Run the packed `@nredd/pi-computer-use` stock contract outside a release.

The contract proves tarball independence and extension discovery against exact stock Pi. Native
macOS desktop behavior requires an interactive TCC-granted session and is explicitly reported as
``NOT RUN`` rather than treated as a passing desktop test.
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
SUBJECT = "@nredd/pi-computer-use"


def main(argv: Sequence[str] | None = None) -> int:
    """Pack, audit, install and load `@nredd/pi-computer-use` on stock Pi.

    Parameters:
        argv: Command-line arguments, or ``None`` for ``sys.argv``.

    Returns:
        Zero when the contract holds, otherwise one.
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
    work = Path(tempfile.mkdtemp(prefix="pi-computer-use-contract-"))
    try:
        report = nr.run_stock_contract(work, args.stock_prefix.resolve(), descriptor, {})
    except (pc.ContractError, nr.ReleaseError) as error:
        LOGGER.error(f"FAILED: {error}")
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)
    text = pc.serialize_report(report)
    if args.report:
        args.report.write_text(text)
    sys.stdout.write(text)
    LOGGER.info("computer-use package contract: passed; native desktop behavior NOT RUN")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
