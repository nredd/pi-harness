#!/usr/bin/env bash
# Compatible guest entry; system Python was already required for the wsl.conf check.
exec python3 "$(dirname "${BASH_SOURCE[0]}")/wsl2_smoke.py" "$@"
