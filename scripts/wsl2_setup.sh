#!/usr/bin/env bash
# Bootstrap tools only. The ordinary ci.yml steps own every gate and scenario.
set -euo pipefail
if [ "$(id -u)" -eq 0 ]; then
  echo 'WSL gates require an unprivileged Linux user' >&2
  exit 1
fi
# Every external command gets a bound sized from hosted passes (#626): the slowest measured leg took about 12s,
# the whole script 23s to 67s. A hang then fails in minutes, naming the command and what the guest was running,
# instead of burning the 45 minute job timeout with no cause.
command_seconds=60
bounded() {
  local label=$1 seconds=$2 status=0
  shift 2
  timeout --kill-after=10 "$seconds" "$@" || status=$?
  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    printf 'wsl2-setup: TIMEOUT: %s exceeded %ss: %s\n' "$label" "$seconds" "$*" >&2
    printf 'wsl2-setup: guest processes, newest first:\n' >&2
    { ps -eo pid,ppid,etime,stat,args --sort=etime | head -n 40 >&2; } || true
  elif [ "$status" -ne 0 ]; then
    printf 'wsl2-setup: FAILED: %s (status %s): %s\n' "$label" "$status" "$*" >&2
  fi
  return "$status"
}
source_checkout=$WSL_HOST_WORKSPACE
case "$source_checkout" in /mnt/*) ;; *) echo 'Expected Windows source below /mnt' >&2; exit 1 ;; esac
worktree="$HOME/pi-harness-ci"
test ! -e "$worktree"
mkdir -p "$worktree"
bounded "copy checkout" "$command_seconds" cp -a "$source_checkout/." "$worktree"
filesystem=$(findmnt --noheadings --output FSTYPE --target "$worktree" | tr -d '[:space:]')
case "$filesystem" in drvfs|'') echo 'Harness worktree is not on a Linux filesystem' >&2; exit 1 ;; esac
cd "$worktree"
# No credentials during bootstrap; only verification/fetch steps forward GH_TOKEN.
unset GH_TOKEN
fetch() {
  # `--max-time` bounds each attempt, `--retry` repeats it; the outer bound covers every attempt.
  bounded "download $1" 180 curl --fail --location --retry 3 --connect-timeout 15 --max-time 45 --output "$2" "$1"
}
node_version=$(tr -d '\r\n' < .node-version)
node_archive="node-v${node_version}-linux-x64.tar.xz"
tool_dir="$HOME/.cache/pi-harness-wsl2-tools"
mkdir -p "$tool_dir"
fetch "https://nodejs.org/dist/v${node_version}/$node_archive" "$tool_dir/$node_archive"
bounded "extract node" "$command_seconds" tar --extract --xz --file "$tool_dir/$node_archive" --directory "$tool_dir"
export PATH="$tool_dir/node-v${node_version}-linux-x64/bin:$PATH"
test "$(node --version)" = "v$node_version"
bounded "install npm" "$command_seconds" npm install --global "$(node -p 'require("./package.json").packageManager')"
bun_version=$(tr -d '\r\n' < .bun-version)
export BUN_INSTALL="$tool_dir/bun"
fetch https://bun.sh/install "$tool_dir/bun-install.sh"
bounded "install bun" "$command_seconds" bash "$tool_dir/bun-install.sh" "bun-v$bun_version"
export PATH="$BUN_INSTALL/bin:$PATH"
test "$(bun --version)" = "$bun_version"
uv_version=0.13.1
fetch "https://astral.sh/uv/$uv_version/install.sh" "$tool_dir/uv-install.sh"
bounded "install uv" "$command_seconds" sh "$tool_dir/uv-install.sh"
export PATH="$HOME/.local/bin:$PATH"
case "$(uv --version)" in "uv $uv_version"*) ;; *) exit 1 ;; esac
bounded "install gh" "$command_seconds" bash scripts/install_gh_linux.sh "$tool_dir/gh"
# Owned Linux gates use real cargo/nextest, not native Windows tools or skipped suites.
if [ "${WSL_OWNED:-false}" = true ]; then
  bounded "install owned tools" 90 bash scripts/install_wsl_owned_tools.sh "$tool_dir"
  PATH=$(< "$tool_dir/owned-tool-path")
  export PATH
fi
export PATH="$tool_dir/gh/bin:$PATH"
mkdir -p "$worktree/.ci-temp"
printf '%s\n' "$PATH" > "$worktree/.ci-temp/tool-path"
printf 'WSL2 Ubuntu-24.04, Linux filesystem: %s\nUser: %s (uid %s)\nNode: %s\nBun: %s\n' "$filesystem" "$(id -un)" "$(id -u)" "$(node --version)" "$(bun --version)" > "$WSL_HOST_TEMP/wsl2-diagnostics/identity.txt"
printf 'Guest setup complete; ordinary CI steps follow.\n' > "$WSL_HOST_TEMP/wsl2-diagnostics/capture-status.txt"
