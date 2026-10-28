#!/usr/bin/env bash
# Export only explicit synthetic reports, never the guest HOME or runner environment.
set -euo pipefail
: "${WSL_HOST_WORKSPACE:?}" "${WSL_HOST_TEMP:?}"
worktree="$HOME/pi-harness-ci"
export RUNNER_TEMP="$worktree/.ci-temp"
export PATH
PATH=$(< "$RUNNER_TEMP/tool-path")
if [ "${1:-}" = cleanup ]; then
  diagnostics_dir="$WSL_HOST_TEMP/wsl2-diagnostics"
  source "$worktree/scripts/wsl2_cleanup.sh"
  finish_capture() {
    capture_status=$?
    set +e
    if [ -f "$RUNNER_TEMP/first-failure" ]; then
      capture_status=$(< "$RUNNER_TEMP/first-failure")
      [[ "$capture_status" =~ ^[0-9]+$ ]] || capture_status=1
    fi
    # The existing helper reads $? on entry, retaining the original guest failure.
    (exit "$capture_status")
    cleanup_wsl2_worktree
    exit "$capture_status"
  }
  trap finish_capture EXIT
fi
for name in artifacts artifacts-node artifacts-personal; do
  # Mirror only these explicit synthetic directories, including absence. Never
  # mix stale Node files into a standalone snapshot after the guest renames it.
  rm -rf "$WSL_HOST_WORKSPACE/integration/$name"
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
  identity=$(git -C "$worktree/forks/pi" rev-parse HEAD)
  printf 'Core Gitlink: %s\n' "$identity" >> "$WSL_HOST_TEMP/wsl2-diagnostics/identity.txt"
fi
if [ -n "${PI_BIN:-}" ] && [ -x "$PI_BIN" ]; then
  mkdir -p "$RUNNER_TEMP/version-home" "$RUNNER_TEMP/version-agent"
  HOME="$RUNNER_TEMP/version-home" PI_CODING_AGENT_DIR="$RUNNER_TEMP/version-agent" "$PI_BIN" --version \
    >> "$WSL_HOST_TEMP/wsl2-diagnostics/identity.txt"
fi
