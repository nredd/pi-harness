#!/usr/bin/env bash
# GitHub must generate a Bash step file, not PowerShell control statements.
set -euo pipefail
expected=${PI_CI_GIT_BASH:?Git Bash selection receipt is missing}
resolved=$(cygpath -w "$(command -v bash)")
expected=$(printf '%s' "${expected%.exe}" | tr '\\' '/' | tr '[:upper:]' '[:lower:]')
resolved=$(printf '%s' "${resolved%.exe}" | tr '\\' '/' | tr '[:upper:]' '[:lower:]')
# Git's bin/bash.exe launcher may resolve its actual usr/bin/bash.exe binary.
alternate="${expected%/bin/bash}/usr/bin/bash"
if [ "$resolved" != "$expected" ] && [ "$resolved" != "$alternate" ]; then
  printf 'Refusing ambiguous Bash: expected %s, resolved %s\n' "$expected" "$resolved" >&2
  exit 1
fi
# MSYS otherwise rewrites guest PI_BIN=/root/... when starting native pwsh.
# Keep ordinary Windows PATH conversion; exclude only this Linux scalar path.
export MSYS2_ENV_CONV_EXCL="PI_BIN${MSYS2_ENV_CONV_EXCL:+;$MSYS2_ENV_CONV_EXCL}"
if ! command -v pwsh >/dev/null; then
  printf 'wsl2-host: pwsh command not found\n' >&2
  exit 127
fi
exec pwsh -NoProfile -File "$GITHUB_WORKSPACE/scripts/wsl2_shell.ps1" "$1"
