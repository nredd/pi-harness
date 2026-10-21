"""Run the packed `@nredd/pi-subagents` stock contract outside a release.

References:
    https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md
"""

from __future__ import annotations

import sys

import stock_package_contract as spc

SUBJECT = "@nredd/pi-subagents"


if __name__ == "__main__":
    raise SystemExit(spc.main(["--package", SUBJECT, *sys.argv[1:]]))
