#!/usr/bin/env bash
# Export only explicit synthetic reports, never the guest HOME or runner environment.
set -euo pipefail
worktree="$HOME/pi-harness-ci"
for name in artifacts artifacts-node artifacts-personal; do
  if [ -d "$worktree/integration/$name" ]; then
    mkdir -p "$WSL_HOST_WORKSPACE/integration/$name"
    cp -a "$worktree/integration/$name/." "$WSL_HOST_WORKSPACE/integration/$name/"
  fi
done
shopt -s nullglob
for report in "$RUNNER_TEMP/"*contracts*.json; do
  cp "$report" "$WSL_HOST_TEMP/"
done
if [ -d "$worktree/forks/pi/.git" ] || [ -f "$worktree/forks/pi/.git" ]; then
  git -C "$worktree/forks/pi" rev-parse HEAD >> "$WSL_HOST_TEMP/wsl2-diagnostics/identity.txt"
fi
if [ -n "${PI_BIN:-}" ] && [ -x "$PI_BIN" ]; then
  mkdir -p "$RUNNER_TEMP/version-home" "$RUNNER_TEMP/version-agent"
  HOME="$RUNNER_TEMP/version-home" PI_CODING_AGENT_DIR="$RUNNER_TEMP/version-agent" "$PI_BIN" --version \
    >> "$WSL_HOST_TEMP/wsl2-diagnostics/identity.txt"
fi
if [ "${1:-}" = cleanup ]; then
  diagnostics_dir="$WSL_HOST_TEMP/wsl2-diagnostics"
  source "$worktree/scripts/wsl2_cleanup.sh"
  trap cleanup_wsl2_worktree EXIT
  if [ -f "$RUNNER_TEMP/first-failure" ]; then
    status=$(< "$RUNNER_TEMP/first-failure")
    [[ "$status" =~ ^[0-9]+$ ]] || exit 1
    exit "$status"
  fi
fi
