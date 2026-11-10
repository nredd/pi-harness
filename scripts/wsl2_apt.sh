#!/usr/bin/env bash
# Root-owned apt prerequisites for the WSL guest (#626). `Vampire/setup-wsl` used to run these through
# `additional-packages` with no bound: run 42756515991 spent 43 of its 44 minutes there, the stock Ubuntu mirrors
# answering at about 50 kB/s with minute-long stalls (`Fetched 89.8 MB in 28min 0s (53.5 kB/s)`).
# Here apt gets short network timeouts and retries, no Translation downloads, and each mirror one bounded attempt:
# Azure's mirror first (hosted runners sit next to it), the stock one if that fails.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo 'wsl2-apt: must run as root' >&2
  exit 1
fi
sources=${WSL_APT_SOURCES:-/etc/apt/sources.list.d/ubuntu.sources}
conf=${WSL_APT_CONF:-/etc/apt/apt.conf.d/99-pi-ci}
update_seconds=${WSL_APT_UPDATE_SECONDS:-90}
install_seconds=${WSL_APT_INSTALL_SECONDS:-180}
packages=(build-essential curl fd-find git jq libatomic1 libssl-dev pkg-config python3 ripgrep tmux unzip xz-utils)
bounded() {
  local label=$1 seconds=$2 status=0
  shift 2
  timeout --kill-after=10 "$seconds" "$@" || status=$?
  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    printf 'wsl2-apt: TIMEOUT: %s exceeded %ss: %s\n' "$label" "$seconds" "$*" >&2
    printf 'wsl2-apt: guest processes, newest first:\n' >&2
    { ps -eo pid,ppid,etime,stat,args --sort=etime | head -n 40 >&2; } || true
  elif [ "$status" -ne 0 ]; then
    printf 'wsl2-apt: FAILED: %s (status %s): %s\n' "$label" "$status" "$*" >&2
  fi
  return "$status"
}
printf '%s\n' \
  'Acquire::Retries "3";' \
  'Acquire::http::Timeout "20";' \
  'Acquire::https::Timeout "20";' \
  'Acquire::ForceIPv4 "true";' \
  'Acquire::Languages "none";' > "$conf"
original=$(< "$sources")
for mirror in http://azure.archive.ubuntu.com/ubuntu http://archive.ubuntu.com/ubuntu; do
  # Point both the archive and security URIs at one mirror; the second pass restores the stock ones.
  printf '%s\n' "$original" | sed -E "s#http://(archive|security)\\.ubuntu\\.com/ubuntu/?#${mirror}/#" > "$sources"
  printf 'wsl2-apt: using %s\n' "$mirror"
  if bounded "apt-get update ($mirror)" "$update_seconds" apt-get update &&
    bounded "apt-get install ($mirror)" "$install_seconds" env DEBIAN_FRONTEND=noninteractive \
      apt-get install --yes --no-install-recommends "${packages[@]}"; then
    exit 0
  fi
  printf 'wsl2-apt: %s failed, trying the next mirror\n' "$mirror" >&2
done
printf '%s\n' "$original" > "$sources"
echo 'wsl2-apt: every mirror failed' >&2
exit 1
