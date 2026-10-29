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
    cp -RP "$worktree/integration/$name/." "$WSL_HOST_WORKSPACE/integration/$name/"
  fi
done
# Owned coverage stays independent per runner. Mirror only the same exact report paths
# uploaded by ci.yml; no guest source, dependency tree, HOME or environment crosses here.
shopt -s nullglob
for report in "$WSL_HOST_WORKSPACE"/packages/*/coverage/*/lcov.info \
  "$WSL_HOST_WORKSPACE"/integration/inprocess/coverage/*/lcov.info \
  "$WSL_HOST_WORKSPACE"/integration/probes/coverage/*/lcov.info \
  "$WSL_HOST_WORKSPACE"/scripts/coverage/*/lcov.info \
  "$WSL_HOST_WORKSPACE"/coverage/summary.json; do
  rm -f "$report"
done
for report in "$worktree"/packages/*/coverage/*/lcov.info \
  "$worktree"/integration/inprocess/coverage/*/lcov.info \
  "$worktree"/integration/probes/coverage/*/lcov.info \
  "$worktree"/scripts/coverage/*/lcov.info \
  "$worktree"/coverage/summary.json; do
  [ -f "$report" ] || continue
  relative=${report#"$worktree/"}
  mkdir -p "$WSL_HOST_WORKSPACE/$(dirname "$relative")"
  cp -P "$report" "$WSL_HOST_WORKSPACE/$relative"
done
# Published atomically by the startup collector only after its allowlist/credential scan.
if [ -d "$RUNNER_TEMP/standalone-startup-diagnostics" ]; then
  staging=$(mktemp -d "$WSL_HOST_TEMP/.standalone-startup.XXXXXX")
  if cp -RP "$RUNNER_TEMP/standalone-startup-diagnostics/." "$staging/"; then
    rm -rf "$WSL_HOST_TEMP/standalone-startup-diagnostics"
    mv "$staging" "$WSL_HOST_TEMP/standalone-startup-diagnostics"
  else
    rm -rf "$staging"
    exit 1
  fi
fi
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
