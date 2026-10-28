#!/usr/bin/env bash
# GitHub must generate a Bash step file, not prepend PowerShell control statements.
# This Windows Git-Bash launcher delegates that unmodified file to the WSL adapter.
set -euo pipefail
exec pwsh -NoProfile -File "$GITHUB_WORKSPACE/scripts/wsl2_shell.ps1" "$1"
