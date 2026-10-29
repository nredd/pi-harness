#!/usr/bin/env bash
# Shared guest execution boundary. GitHub control files stay Windows-visible;
# builds, caches, dependencies and tests remain on the Linux filesystem.
set -euo pipefail
worktree="$HOME/pi-harness-ci"
export RUNNER_TEMP="$worktree/.ci-temp"
step=
# Retain the first ordinary-step failure, including adapter preflight failures.
record_status() {
  status=$?
  set +e
  if [ "$status" -ne 0 ] && [ ! -f "$RUNNER_TEMP/first-failure" ]; then
    printf '%s\n' "$status" > "$RUNNER_TEMP/first-failure"
  fi
  if [ -n "$step" ]; then rm -f "$step"; fi
  return "$status"
}
trap record_status EXIT
if [ "$(id -u)" -eq 0 ]; then
  echo 'WSL gates require an unprivileged Linux user' >&2
  exit 1
fi
test -s "$RUNNER_TEMP/tool-path"
export PATH
PATH=$(< "$RUNNER_TEMP/tool-path")
export GITHUB_WORKSPACE="$worktree"
# Resolve physical paths so '..', nested traversal and symlinks cannot escape.
worktree=$(cd -P "$worktree" && pwd)
if ! cd -P "$worktree/$WSL_STEP_DIRECTORY"; then
  echo 'Step directory escapes guest checkout or is unavailable' >&2
  exit 1
fi
case "$PWD/" in "$worktree/"*) ;; *) echo 'Step directory escapes guest checkout' >&2; exit 1 ;; esac
# Do not modify the host-generated step; CRLF is possible even with an LF checkout.
step=$(mktemp "$RUNNER_TEMP/step.XXXXXX")
tr -d '\r' < "$WSL_STEP_SCRIPT" > "$step"
set +e
bash --noprofile --norc -e -o pipefail "$step"
status=$?
set -e
if [ "$status" -ne 0 ]; then
  printf 'wsl2-run: guest-step failed with status %s\n' "$status" >&2
  exit "$status"
fi
