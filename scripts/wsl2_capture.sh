#!/usr/bin/env bash
# Compatibility bootstrap only, intentionally unmeasured; the capture logic lives in wsl2_capture.py.
set -euo pipefail
exec python3 "$(dirname "${BASH_SOURCE[0]}")/wsl2_capture.py" "$@"
