#!/usr/bin/env bash
# Bootstrap tools only. The ordinary ci.yml steps own every gate and scenario.
#
# Two modes:
# - Hosted (default): a Windows runner copies its /mnt checkout into a fresh `pi-ci` home and installs every tool.
# - In guest (PI_WSL2_IN_GUEST=1): the self-hosted pi-wsl2 runner already lives in the distro as an unprivileged
#   user, the checkout is on ext4 at GITHUB_WORKSPACE, and the golden image bakes the toolchains. Tools whose
#   version already matches the repo pins are reused; only a mismatch downloads (public internet is allowed).
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
in_guest=${PI_WSL2_IN_GUEST:-}
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  aarch64 | arm64) node_arch=arm64 ;;
  *) echo "wsl2-setup: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
if [ "$in_guest" = 1 ]; then
  worktree=${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required in guest mode}
  test -d "$worktree/.git" || test -f "$worktree/.git"
else
  source_checkout=$WSL_HOST_WORKSPACE
  case "$source_checkout" in /mnt/*) ;; *) echo 'Expected Windows source below /mnt' >&2; exit 1 ;; esac
  worktree="$HOME/pi-harness-ci"
  test ! -e "$worktree"
  mkdir -p "$worktree"
  bounded "copy checkout" "$command_seconds" cp -a "$source_checkout/." "$worktree"
fi
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
node_dir="node-v${node_version}-linux-${node_arch}"
node_archive="$node_dir.tar.xz"
tool_dir="$HOME/.cache/pi-harness-wsl2-tools"
mkdir -p "$tool_dir"
# Golden-image reuse, guest mode only: true when the command's first output line is the expected text, alone or
# followed by a space (`uv --version` appends a commit and date).
baked() {
  local expected=$1 actual
  shift
  [ "$in_guest" = 1 ] || return 1
  actual=$("$@" 2>/dev/null | head -n1) || return 1
  [ "$actual" = "$expected" ] || [ "${actual#"$expected" }" != "$actual" ]
}
if [ -x "$tool_dir/$node_dir/bin/node" ]; then
  export PATH="$tool_dir/$node_dir/bin:$PATH"
fi
if ! baked "v$node_version" node --version; then
  fetch "https://nodejs.org/dist/v${node_version}/$node_archive" "$tool_dir/$node_archive"
  bounded "extract node" "$command_seconds" tar --extract --xz --file "$tool_dir/$node_archive" --directory "$tool_dir"
  export PATH="$tool_dir/$node_dir/bin:$PATH"
fi
test "$(node --version)" = "v$node_version"
package_manager=$(node -p 'require("./package.json").packageManager')
npm_version=${package_manager#*@}
if ! baked "${npm_version%%+*}" npm --version; then
  # A baked node may live under a root-owned prefix: install into a prefix this user owns.
  npm_prefix="$tool_dir/npm"
  mkdir -p "$npm_prefix"
  bounded "install npm" "$command_seconds" env npm_config_prefix="$npm_prefix" npm install --global "$package_manager"
  export PATH="$npm_prefix/bin:$PATH"
fi
bun_version=$(tr -d '\r\n' < .bun-version)
export BUN_INSTALL="$tool_dir/bun"
export PATH="$BUN_INSTALL/bin:$HOME/.bun/bin:$PATH"
if ! baked "$bun_version" bun --version; then
  fetch https://bun.sh/install "$tool_dir/bun-install.sh"
  bounded "install bun" "$command_seconds" bash "$tool_dir/bun-install.sh" "bun-v$bun_version"
fi
test "$(bun --version)" = "$bun_version"
uv_version=0.13.1
export PATH="$HOME/.local/bin:$PATH"
if ! baked "uv $uv_version" uv --version; then
  fetch "https://astral.sh/uv/$uv_version/install.sh" "$tool_dir/uv-install.sh"
  bounded "install uv" "$command_seconds" sh "$tool_dir/uv-install.sh"
fi
case "$(uv --version)" in "uv $uv_version"*) ;; *) exit 1 ;; esac
gh_version=$(sed -n 's/^GH_VERSION=//p' scripts/install_gh_linux.sh)
if ! baked "gh version $gh_version" "$tool_dir/gh/bin/gh" --version; then
  bounded "install gh" "$command_seconds" bash scripts/install_gh_linux.sh "$tool_dir/gh"
fi
# Owned Linux gates use real cargo/nextest, not native Windows tools or skipped suites.
if [ "${WSL_OWNED:-false}" = true ]; then
  # `rust-toolchain.toml` selects the pinned channel; the probe makes rustup fetch it if the golden lags.
  owned_probe='cargo fmt --version && cargo clippy --version && cargo nextest --version'
  if [ "$in_guest" = 1 ] && PATH="$HOME/.cargo/bin:$PATH" timeout --kill-after=10 300 bash -c "$owned_probe" >/dev/null 2>&1; then
    PATH="$HOME/.cargo/bin:$PATH"
    export PATH
  else
    bounded "install owned tools" 90 bash scripts/install_wsl_owned_tools.sh "$tool_dir"
    PATH=$(< "$tool_dir/owned-tool-path")
    export PATH
  fi
fi
export PATH="$tool_dir/gh/bin:$PATH"
if [ "$in_guest" = 1 ]; then
  diagnostics=${RUNNER_TEMP:?RUNNER_TEMP is required in guest mode}/wsl2-diagnostics
else
  diagnostics=$WSL_HOST_TEMP/wsl2-diagnostics
fi
mkdir -p "$worktree/.ci-temp" "$diagnostics"
printf '%s\n' "$PATH" > "$worktree/.ci-temp/tool-path"
printf 'WSL2 %s, Linux filesystem: %s\nUser: %s (uid %s)\nArch: %s\nNode: %s\nBun: %s\n' "${WSL_DISTRO_NAME:-unknown}" "$filesystem" "$(id -un)" "$(id -u)" "$(uname -m)" "$(node --version)" "$(bun --version)" > "$diagnostics/identity.txt"
printf 'Guest setup complete; ordinary CI steps follow.\n' > "$diagnostics/capture-status.txt"
if [ "$in_guest" = 1 ]; then
  # Later steps are plain Linux bash on this runner: hand them the tool path through the runner's PATH file.
  # The runner prepends each GITHUB_PATH line, so the last line written ends up first in PATH: write them in reverse
  # to keep this script's own precedence (a tool it just installed must beat a stale baked copy).
  tr ':' '\n' <<< "$PATH" | while IFS= read -r directory; do
    case "$directory" in "$HOME"/*) printf '%s\n' "$directory" ;; esac
  done | tac >> "${GITHUB_PATH:?GITHUB_PATH is required in guest mode}"
fi
