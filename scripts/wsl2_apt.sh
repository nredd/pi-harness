#!/usr/bin/env bash
# Root-owned apt prerequisites for the WSL guest (#626). `Vampire/setup-wsl` used to run these through
# `additional-packages` with no bound: run 42756515991 spent 43 of its 44 minutes there, the stock Ubuntu mirrors
# answering at about 50 kB/s with minute-long stalls (`Fetched 89.8 MB in 28min 0s (53.5 kB/s)`).
# PR 654's first run showed the index fetch is fast (32 MB in 5s) but the .deb downloads crawl (up to 290 kB/s, stalls
# of tens of seconds) even from Azure's mirror. So: short network timeouts and retries, no Translation downloads,
# a bounded `--download-only` pass per mirror (Azure first, the stock one if that fails; apt resumes `partial/`), the
# downloaded .debs kept in `WSL_APT_CACHE` (a host directory the workflow caches) and restored from it next time,
# and an offline install against the mirror whose `update` succeeded. The sources are NOT restored: apt's lists only
# match that mirror, and the guest is ephemeral per job.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo 'wsl2-apt: must run as root' >&2
  exit 1
fi
sources=${WSL_APT_SOURCES:-/etc/apt/sources.list.d/ubuntu.sources}
conf=${WSL_APT_CONF:-/etc/apt/apt.conf.d/99-pi-ci}
archives=${WSL_APT_ARCHIVES:-/var/cache/apt/archives}
cache=${WSL_APT_CACHE:-}
update_seconds=${WSL_APT_UPDATE_SECONDS:-100}
download_seconds=${WSL_APT_DOWNLOAD_SECONDS:-360}
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
# `timeout` runs a program, not a shell function, so the install command is an array.
install=(env DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends)
printf '%s\n' \
  'Acquire::Retries "3";' \
  'Acquire::http::Timeout "20";' \
  'Acquire::https::Timeout "20";' \
  'Acquire::ForceIPv4 "true";' \
  'Acquire::Languages "none";' > "$conf"
if [ ! -r "$sources" ]; then
  printf 'wsl2-apt: apt sources file not found: %s\n' "$sources" >&2
  exit 1
fi
mkdir -p "$archives/partial"
if [ -n "$cache" ] && compgen -G "$cache/*.deb" > /dev/null; then
  cp -n "$cache"/*.deb "$archives/"
  printf 'wsl2-apt: restored %s cached packages\n' "$(find "$cache" -name '*.deb' | wc -l | tr -d ' ')"
fi
original=$(< "$sources")
fetched=false
for mirror in http://azure.archive.ubuntu.com/ubuntu http://archive.ubuntu.com/ubuntu; do
  # Point both the archive and security URIs at one mirror.
  printf '%s\n' "$original" | sed -E "s#http://(archive|security)\\.ubuntu\\.com/ubuntu/?#${mirror}/#" > "$sources"
  if ! grep -q "$mirror" "$sources"; then
    printf 'wsl2-apt: %s is not in %s after rewriting it\n' "$mirror" "$sources" >&2
  fi
  printf 'wsl2-apt: using %s\n' "$mirror"
  if bounded "apt-get update ($mirror)" "$update_seconds" apt-get update &&
    bounded "apt-get download ($mirror)" "$download_seconds" "${install[@]}" --download-only "${packages[@]}"; then
    fetched=true
    break
  fi
  printf 'wsl2-apt: %s failed, trying the next mirror\n' "$mirror" >&2
done
if [ "$fetched" != true ]; then
  echo 'wsl2-apt: every mirror failed' >&2
  exit 1
fi
# Everything is on disk now: the install needs no network, so a failure here is not a mirror problem.
bounded "apt-get install" "$install_seconds" "${install[@]}" "${packages[@]}"
if [ -n "$cache" ]; then
  # Drop .debs for superseded versions (restore-keys brings back last week's), then make the cache match
  # `archives`, so a warm cache stays bounded to what the current package set needs.
  apt-get autoclean > /dev/null || true
  mkdir -p "$cache"
  find "$cache" -maxdepth 1 -name '*.deb' -delete
  find "$archives" -maxdepth 1 -name '*.deb' -exec cp {} "$cache"/ \;
fi
