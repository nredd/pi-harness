#!/usr/bin/env bash
# Shared guest execution boundary. GitHub control files stay Windows-visible;
# builds, caches, dependencies and tests remain on the Linux filesystem.
set -euo pipefail
worktree="$HOME/pi-harness-ci"
test -s "$worktree/.ci-temp/tool-path"
export PATH
PATH=$(< "$worktree/.ci-temp/tool-path")
export RUNNER_TEMP="$worktree/.ci-temp"
export GITHUB_WORKSPACE="$worktree"
case "$WSL_STEP_DIRECTORY" in /*|../*) echo 'Step directory escapes guest checkout' >&2; exit 1 ;; esac
cd "$worktree/$WSL_STEP_DIRECTORY"
# Do not modify the host-generated step; CRLF is possible even with an LF checkout.
step=$(mktemp "$RUNNER_TEMP/step.XXXXXX")
# Retain the first ordinary-step failure through later successful report steps.
record_status() {
  status=$?
  set +e
  if [ "$status" -ne 0 ] && [ ! -f "$RUNNER_TEMP/first-failure" ]; then
    printf '%s\n' "$status" > "$RUNNER_TEMP/first-failure"
  fi
  rm -f "$step"
  return "$status"
}
trap record_status EXIT
tr -d '\r' < "$WSL_STEP_SCRIPT" > "$step"
bash --noprofile --norc -e -o pipefail "$step"
