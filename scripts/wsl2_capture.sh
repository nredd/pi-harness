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
  # Failure-only guest evidence for whole-guest stalls (#445): unprivileged kernel log plus memory,
  # swap and pressure state. Fixed /proc files and dmesg only, no sudo, environment or HOME. The
  # shared credential policy scans the synthetic report before export. Nothing here alters the
  # capture status.
  capture_guest_state() {
    local report="$RUNNER_TEMP/guest-state.txt" kernel_log="$RUNNER_TEMP/guest-dmesg.txt" path
    {
      printf 'WSL guest state at %s (UTC): guest status %s, job status %s\n' "$(date -u +%FT%TZ)" \
        "$capture_status" "${WSL_JOB_STATUS:-unknown}"
      for path in /proc/uptime /proc/loadavg /proc/meminfo /proc/swaps /proc/pressure/cpu \
        /proc/pressure/memory /proc/pressure/io /proc/sys/kernel/dmesg_restrict; do
        printf '\n== %s ==\n' "$path"
        cat "$path" 2>/dev/null || printf 'UNAVAILABLE: not readable\n'
      done
      printf '\n== /proc/vmstat (swap, reclaim, OOM) ==\n'
      grep -E '^(pswpin|pswpout|pgmajfault|allocstall_[a-z0-9]+|oom_kill) ' /proc/vmstat 2>/dev/null \
        || printf 'UNAVAILABLE: not readable\n'
      if timeout 20 dmesg >"$kernel_log" 2>/dev/null; then
        printf '\n== dmesg unprivileged (last 400 lines) ==\n'
        tail -n 400 "$kernel_log"
      else
        printf '\n== dmesg ==\nUNAVAILABLE: unprivileged dmesg failed (see dmesg_restrict above)\n'
      fi
    } >"$report" 2>/dev/null
    rm -f "$kernel_log"
    if (cd "$worktree/integration" && timeout 60 python3 -m harness.credentials "$report"); then
      cat "$report" >"$diagnostics_dir/guest-state.txt" \
        || printf 'WARNING: could not export WSL guest state\n' >&2
    else
      printf 'WSL guest state withheld: the shared credential scan refused it or could not run.\n' \
        >"$diagnostics_dir/guest-state.txt" || printf 'WARNING: could not record withheld guest state\n' >&2
    fi
  }
  finish_capture() {
    capture_status=$?
    set +e
    if [ -f "$RUNNER_TEMP/first-failure" ]; then
      capture_status=$(< "$RUNNER_TEMP/first-failure")
      [[ "$capture_status" =~ ^[0-9]+$ ]] || capture_status=1
    fi
    # A timeout or cancel kills the guest step before `wsl2_run.sh` writes first-failure, so the
    # caller's job status also triggers collection. It never changes capture_status.
    if [ "$capture_status" -ne 0 ] || [ "${WSL_JOB_STATUS:-success}" != success ]; then
      capture_guest_state
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
  "$WSL_HOST_WORKSPACE"/integration/providers/coverage/*/lcov.info \
  "$WSL_HOST_WORKSPACE"/scripts/coverage/*/lcov.info \
  "$WSL_HOST_WORKSPACE"/coverage/summary.json; do
  rm -f "$report"
done
for report in "$worktree"/packages/*/coverage/*/lcov.info \
  "$worktree"/integration/inprocess/coverage/*/lcov.info \
  "$worktree"/integration/probes/coverage/*/lcov.info \
  "$worktree"/integration/providers/coverage/*/lcov.info \
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
