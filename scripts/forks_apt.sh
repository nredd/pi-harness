#!/usr/bin/env bash
# Fetch then install the upstream core CI prerequisites on a disposable Ubuntu 24.04 runner.
set -euo pipefail

# shellcheck source=scripts/ubuntu_apt.sh
source "${BASH_SOURCE[0]%/*}/ubuntu_apt.sh"
apt_label=forks-apt
sources=$1
apt_log=$2
update_seconds=$3
download_seconds=$4
install_seconds=$5
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
selected="$scratch/ubuntu.sources"
packages=(libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev fd-find ripgrep)
apt=(env DEBIAN_FRONTEND=noninteractive apt-get
  -o "Dir::Etc::sourcelist=$selected" -o Dir::Etc::sourceparts=-
  -o Acquire::Retries=1 -o Acquire::http::Timeout=10 -o Acquire::https::Timeout=10
  -o Acquire::Languages=none -o DPkg::Lock::Timeout=10 -o Dpkg::Use-Pty=0)

fetch() {
  local mirror=$1
  apt_bounded "apt-get update ($mirror)" "$update_seconds" "${apt[@]}" update --error-on=any &&
    apt_bounded "apt-get download ($mirror)" "$download_seconds" "${apt[@]}" install --yes --download-only "${packages[@]}"
}
apt_fetch_from_mirror "$sources" "$selected" fetch
# Do not retry dpkg failures on another mirror. Everything needed is already in the archives.
apt_bounded 'apt-get install' "$install_seconds" "${apt[@]}" install --yes --no-download "${packages[@]}"
