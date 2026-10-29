#!/usr/bin/env bash
# Bootstrap tools only. The ordinary ci.yml steps own every gate and scenario.
set -euo pipefail
if [ "$(id -u)" -eq 0 ]; then
  echo 'WSL gates require an unprivileged Linux user' >&2
  exit 1
fi
source_checkout=$WSL_HOST_WORKSPACE
case "$source_checkout" in /mnt/*) ;; *) echo 'Expected Windows source below /mnt' >&2; exit 1 ;; esac
worktree="$HOME/pi-harness-ci"
test ! -e "$worktree"
mkdir -p "$worktree"
cp -a "$source_checkout/." "$worktree"
filesystem=$(findmnt --noheadings --output FSTYPE --target "$worktree" | tr -d '[:space:]')
case "$filesystem" in drvfs|'') echo 'Harness worktree is not on a Linux filesystem' >&2; exit 1 ;; esac
cd "$worktree"
# No credentials during bootstrap; only verification/fetch steps forward GH_TOKEN.
unset GH_TOKEN
node_version=$(tr -d '\r\n' < .node-version)
node_archive="node-v${node_version}-linux-x64.tar.xz"
tool_dir="$HOME/.cache/pi-harness-wsl2-tools"
mkdir -p "$tool_dir"
curl --fail --location --retry 3 --output "$tool_dir/$node_archive" "https://nodejs.org/dist/v${node_version}/$node_archive"
tar --extract --xz --file "$tool_dir/$node_archive" --directory "$tool_dir"
export PATH="$tool_dir/node-v${node_version}-linux-x64/bin:$PATH"
test "$(node --version)" = "v$node_version"
npm install --global "$(node -p 'require("./package.json").packageManager')"
bun_version=$(tr -d '\r\n' < .bun-version)
export BUN_INSTALL="$tool_dir/bun"
curl --fail --location --retry 3 https://bun.sh/install | bash -s -- "bun-v$bun_version"
export PATH="$BUN_INSTALL/bin:$PATH"
test "$(bun --version)" = "$bun_version"
uv_version=0.13.1
curl --fail --location --retry 3 "https://astral.sh/uv/$uv_version/install.sh" | sh
export PATH="$HOME/.local/bin:$PATH"
case "$(uv --version)" in "uv $uv_version"*) ;; *) exit 1 ;; esac
bash scripts/install_gh_linux.sh "$tool_dir/gh"
# Owned Linux gates use real cargo/nextest, not native Windows tools or skipped suites.
if [ "${WSL_OWNED:-false}" = true ]; then
  bash scripts/install_wsl_owned_tools.sh "$tool_dir"
  PATH=$(< "$tool_dir/owned-tool-path")
  export PATH
fi
export PATH="$tool_dir/gh/bin:$PATH"
mkdir -p "$worktree/.ci-temp"
printf '%s\n' "$PATH" > "$worktree/.ci-temp/tool-path"
printf 'WSL2 Ubuntu-24.04, Linux filesystem: %s\nUser: %s (uid %s)\nNode: %s\nBun: %s\n' "$filesystem" "$(id -un)" "$(id -u)" "$(node --version)" "$(bun --version)" > "$WSL_HOST_TEMP/wsl2-diagnostics/identity.txt"
printf 'Guest setup complete; ordinary CI steps follow.\n' > "$WSL_HOST_TEMP/wsl2-diagnostics/capture-status.txt"
