#!/usr/bin/env bash
# Compatibility bootstrap only, intentionally unmeasured; the guest execution boundary lives in wsl2_run.py.
set -euo pipefail
exec python3 "$(dirname "${BASH_SOURCE[0]}")/wsl2_run.py" "$@"
