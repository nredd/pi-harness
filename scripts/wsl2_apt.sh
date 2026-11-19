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

# shellcheck source=scripts/ubuntu_apt.sh
source "${BASH_SOURCE[0]%/*}/ubuntu_apt.sh"
apt_label=wsl2-apt
apt_log=
if [ "$(id -u)" -ne 0 ]; then
  echo 'wsl2-apt: must run as root' >&2
  exit 1
fi
# Apt runs before the ordinary guest checkout/capture exists. On failure, retain
# only allowlisted DNS outcomes directly in the host's existing diagnostic directory.
# The saved status and outer bound also cover absent tools and blocked artifact IO.
capture_apt_failure() {
  local status=$?
  trap - EXIT
  set +e
  if [ "$status" -ne 0 ]; then
    timeout --kill-after=1 12 bash "${BASH_SOURCE[0]%/*}/wsl2_dns_diagnostics.sh" \
      "${WSL_APT_DIAGNOSTICS:-}" || printf 'wsl2-apt: DNS diagnostics unavailable or incomplete\n' >&2
  fi
  exit "$status"
}
trap capture_apt_failure EXIT
sources=${WSL_APT_SOURCES:-/etc/apt/sources.list.d/ubuntu.sources}
conf=${WSL_APT_CONF:-/etc/apt/apt.conf.d/99-pi-ci}
archives=${WSL_APT_ARCHIVES:-/var/cache/apt/archives}
cache=${WSL_APT_CACHE:-}
update_seconds=${WSL_APT_UPDATE_SECONDS:-100}
download_seconds=${WSL_APT_DOWNLOAD_SECONDS:-360}
install_seconds=${WSL_APT_INSTALL_SECONDS:-180}
packages=(build-essential curl fd-find git jq libatomic1 libssl-dev pkg-config python3 ripgrep tmux unzip xz-utils)
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
fetch() {
  local mirror=$1
  apt_bounded "apt-get update ($mirror)" "$update_seconds" apt-get update --error-on=any &&
    apt_bounded "apt-get download ($mirror)" "$download_seconds" "${install[@]}" --download-only "${packages[@]}"
}
apt_fetch_from_mirror "$sources" "$sources" fetch
# Everything is on disk now: the install needs no network, so a failure here is not a mirror problem.
apt_bounded "apt-get install" "$install_seconds" "${install[@]}" "${packages[@]}"
# Refresh the host cache. Housekeeping must not fail a setup whose install succeeded: a partly
# emptied cache only costs the next run a download (a failed job saves no cache anyway). Calling it
# on the left of `||` also suspends `set -e` inside it.
prune_cache() {
  # Keep exactly the .debs whose version is installed (restore-keys brings back last week's superseded ones;
  # `apt-get autoclean` would keep any version the mirror still lists), so a warm cache stays bounded to the
  # current package set. Build the new set aside so an empty `archives` cannot wipe a good cache.
  kept=$(mktemp -d)
  trap 'rm -rf "$kept"' EXIT
  for deb in "$archives"/*.deb; do
    [ -e "$deb" ] || continue
    # An unreadable .deb is simply not kept; housekeeping must not fail the setup.
    name=$(dpkg-deb -f "$deb" Package 2> /dev/null) || continue
    version=$(dpkg-deb -f "$deb" Version 2> /dev/null) || continue
    arch=$(dpkg-deb -f "$deb" Architecture 2> /dev/null) || continue
    [ "$arch" = all ] || name="$name:$arch"
    if [ "$(dpkg-query -W -f='${Version}' "$name" 2> /dev/null || true)" = "$version" ]; then
      cp "$deb" "$kept"/
    fi
  done
  if compgen -G "$kept/*.deb" > /dev/null; then
    mkdir -p "$cache"
    find "$cache" -maxdepth 1 -name '*.deb' -delete
    cp "$kept"/*.deb "$cache"/
  else
    echo 'wsl2-apt: no installed .debs found in the archives, leaving the host cache as it was' >&2
  fi
}
if [ -n "$cache" ]; then
  prune_cache || echo 'wsl2-apt: cache refresh failed, continuing' >&2
fi
