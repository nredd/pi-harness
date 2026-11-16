#!/usr/bin/env bash
# Compatibility bootstrap only; measured setup runs after apt guarantees system Python.
set -euo pipefail
exec python3 "$(dirname "${BASH_SOURCE[0]}")/wsl2_setup.py" "$@"
