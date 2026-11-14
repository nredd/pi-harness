#!/usr/bin/env bash
# Compatibility bootstrap only, intentionally unmeasured; the installer lives in install_wsl_owned_tools.py.
set -euo pipefail
exec python3 "$(dirname "${BASH_SOURCE[0]}")/install_wsl_owned_tools.py" "$@"
